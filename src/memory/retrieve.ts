/**
 * 结构化召回：先锁定卡片，再（按需）翻原始记录。
 *
 * 为什么不用向量（这是 v2 的核心决定）：
 *   余弦相似度没有时间轴，也没有"是否仍然成立"的概念。
 *   三周前的一句玩笑和昨天的一句陈述，在向量空间里可能比同一件事的前后
 *   两种说法更近。结果就是"把很久以前已失效的事当成现状"。
 *
 * 六路 + 打分 + **时间覆盖式选择**：
 *
 *   关键词通道  card_fts（bigram + 单字，两段式）
 *   时间通道    用户这句话里解析出的时间窗；没有时间窗就看"最近得知的"
 *   情绪通道    v3：心情不好时更容易想起难过的事（affect-congruent recall）
 *   社交通道    人物 / 未了之事 / 实体命中
 *   种子通道    动机卡点名的卡片（follow_up 指回那条未了之事的卡）
 *   反刍通道    v3：低概率塞进一张"突然想起来"的旧卡，不在正常排名区间里
 *
 * 打分（和为 0.90）：
 *   0.36 关键词     0.20 时间契合   0.12 强度
 *   0.08 重要性     0.08 情绪同频   0.06 社交
 * 再乘 statusFactor / kindFactor / confidenceFactor。
 *
 * 覆盖选择：先取最高分，之后优先补齐"不同的日子"。
 * 这样带进提示词的是几个时间点，而不是五条同类记忆。
 *
 * 线程展开：命中卡片若属于某条线，或**声明过因果**（card_link），顺带取邻居
 * 并标成"变化"，把来龙去脉一起带进提示词 —— 连同那条线的 summary。
 *
 * ── v3 修掉的两个语义错误 ────────────────────────────────
 *   1. "最近"通道以前按 event_at 取。一张"下周三出差"的计划卡 event_at 在未来，
 *      于是它永远命中、且按 DESC 排第一。现在按 created_at（我什么时候得知）。
 *   2. timeFit 以前是 exp(-max(0, now - event_at)/7d)，未来卡片被钳成 0 距离、
 *      拿满分。现在未来也要付距离代价（而且罚得更重）。
 */
import type { Env } from "../env.ts";
import type { MotivationCard, RecallQuery, RetrievedCard, TraceSlice } from "../shared/types.ts";
import type { CardRow, ThreadRow } from "../store/repos.ts";
import {
  boostCard,
  getCards,
  getThreads,
  linkedNeighbors,
  listOpenLoops,
  liveCards,
  logRecall,
  recentByCreation,
  searchFts,
  threadCards,
  toRetrievedCard,
  traceRange,
  tracesAround,
} from "../store/repos.ts";
import { inWindow, parseTimeHint } from "../shared/timeparse.ts";

const DAY = 86_400_000;

/** 打分权重（和为 0.90）。改这里之前先看 README 的「调参地图」。 */
export const WEIGHTS = {
  keyword: 0.36,
  time: 0.2,
  strength: 0.12,
  salience: 0.08,
  affect: 0.08,
  social: 0.06,
} as const;

export interface RecallInput {
  now: number;
  turnId: number;
  queryText: string;
  card: MotivationCard | null;
  personId: number | null;
  /** 当前心情：情绪同频通道用。不传就关闭这一路 */
  affect?: { v: number; a: number };
  /** 反刍用的随机源。评测里注入固定值就能复现 */
  rng?: () => number;
  /** 关掉反刍（评测/探针用：/mem 不该被随机性干扰） */
  noSerendipity?: boolean;
  /**
   * 只读试探：不写 recall_log、不 boost 强度。
   * /mem 和评测必须用它 —— 调试工具不该改动你要观察的对象。
   */
  dryRun?: boolean;
}

export interface RecallOutput {
  cards: RetrievedCard[];
  tokens: number;
  query: RecallQuery;
  channels: Record<string, number>;
}

/** 构造结构化查询条件：时间窗 + 关键词 + 人物 + 种子卡片 */
export function buildQuery(input: RecallInput): RecallQuery {
  const text = [input.queryText, input.card?.why ?? "", input.card?.desired_outcome ?? ""]
    .filter(Boolean)
    .join(" ");
  // 时间窗优先取用户这句话里的（"昨天那个事"），动机卡里的说法只作兜底
  const win = parseTimeHint(input.queryText, input.now) ?? parseTimeHint(input.card?.why ?? "", input.now);
  return {
    text,
    keywords: [], // 关键词直接交给 FTS：bigram 本身就是分词，不需要额外抽词
    window: win,
    personId: input.personId,
    seedCardIds: input.card?.seed_card_ids ?? [],
  };
}

/** 关键词相关度归一化：bm25 是负值且量级不稳，所以只用名次 */
function rankScore(index: number, total: number): number {
  return total <= 1 ? 1 : 1 - index / total;
}

interface Cand {
  fts: number;
  time: number;
  person: number;
  loop: number;
  recent: number;
  seed: number;
  sudden: number;
}

export async function recall(env: Env, input: RecallInput): Promise<RecallOutput> {
  const { cfg } = env;
  const q = buildQuery(input);
  const channels: Record<string, number> = {};

  const cand = new Map<number, Cand>();
  const touch = (id: number): Cand => {
    let e = cand.get(id);
    if (!e) {
      e = { fts: 0, time: 0, person: 0, loop: 0, recent: 0, seed: 0, sudden: 0 };
      cand.set(id, e);
    }
    return e;
  };

  const rows = new Map<number, CardRow>();
  const addRow = (r: CardRow): CardRow => {
    rows.set(r.id, r);
    return r;
  };

  // ── 关键词通道 ──
  const ftsHits = searchFts(env.db, q.text, cfg.recall.ftsTopK);
  ftsHits.forEach((h, i) => {
    touch(h.id).fts = rankScore(i, ftsHits.length);
  });
  channels.fts = ftsHits.length;

  for (const r of getCards(env.db, [...cand.keys()])) addRow(r);

  // ── 时间通道 ──
  if (q.window) {
    const inWin = cardsInWindow(env, q.window.from, q.window.to);
    for (const r of inWin) {
      addRow(r);
      touch(r.id).time = 1;
    }
    channels.time = inWin.length;
  } else {
    // 没有时间窗 = "最近聊过什么"。问的是我什么时候知道的，不是事情发生在什么时候。
    const recent = recentByCreation(env.db, input.now - cfg.recall.recentWindowMs, 20);
    for (const r of recent) {
      addRow(r);
      touch(r.id).recent = 1;
    }
    channels.recent = recent.length;
  }

  // ── 社交通道：未了之事 ──
  //
  // ★ v3 移除了"人物通道"。理由不是它坏了，是它在单用户部署下**恒等于全量**：
  //   全库只有一个人，cardsByPerson(primary, 15) 每轮都稳定返回最近 15 张，
  //   于是
  //     (a) 每张卡白拿 0.06 分（一个没有区分度的加分）；
  //     (b) 这 15 张全部塞进候选池，把池子撑大、逼得必须用相对截断兜底；
  //     (c) 反刍通道永远找不到"不在候选池里的旧卡" —— 因为池子里什么都有。
  //   多个人格/多个联系人之前，这一路没有信息量。person_id 列保留着，
  //   entityHit（实体命中）承担了原来"和这个人相关"的区分职责。
  const loops = listOpenLoops(env.db, 5);
  const loopCardIds = loops.map((l) => l.card_id).filter((x): x is number => typeof x === "number");
  for (const r of getCards(env.db, loopCardIds)) {
    addRow(r);
    touch(r.id).loop = 1;
  }
  channels.loop = loopCardIds.length;

  // ── 种子通道：动机卡点名的卡片 ──
  for (const r of getCards(env.db, q.seedCardIds)) {
    addRow(r);
    touch(r.id).seed = 1;
  }
  channels.seed = q.seedCardIds.length;

  // ── 反刍通道：突然想起来 ──
  // 为什么要有：正常的六路召回永远只会想起"和当前话题相关"的事，
  // 于是一个有记忆的角色实际上只会被话题牵着走，不会自己冒出念头。
  // 这里低概率塞一张**跟话题无关但当时很重要**的旧卡，给它一个中档分数：
  // 能进提示词，但不会挤掉真正相关的记忆。
  const rng = input.rng ?? Math.random;
  if (!input.noSerendipity && (channels.fts > 0 || channels.recent > 0) && rng() < cfg.recall.serendipityChance) {
    const pool = liveCards(env.db, 120)
      .filter((r) => !cand.has(r.id))
      .filter((r) => r.salience >= 0.45 && r.strength >= 0.15)
      .filter((r) => r.event_at < input.now - 6 * 3_600_000); // 至少半天前的，才像"忽然想起"
    if (pool.length > 0) {
      const pickIdx = Math.floor(rng() * pool.length) % pool.length;
      const pick = pool[pickIdx];
      addRow(pick);
      touch(pick.id).sudden = 1;
      channels.sudden = 1;
    }
  }

  if (cand.size === 0) return { cards: [], tokens: 0, query: q, channels };

  // 补齐正文（fts 命中但还没加载的）
  for (const id of [...cand.keys()]) {
    if (!rows.has(id)) {
      const r = getCards(env.db, [id])[0];
      if (r) addRow(r);
    }
  }

  // ── 打分 ──
  const vNow = input.affect?.v ?? 0;
  const aNow = input.affect?.a ?? 0;
  const queryTokens = tokenSet(q.text);

  const scored = [...cand.entries()]
    .map(([id, ch]) => {
      const row = rows.get(id);
      if (!row || row.superseded_by !== null || row.strength <= 0.05) return null;

      // 时间契合：未来也付代价，而且罚得更重（1.5 倍距离）。
      // 否则"下周要出差"这类卡会在整整一周里拿满分时间分。
      let timeFit: number;
      if (q.window) {
        timeFit = inWindow(row.event_at, q.window, row.time_precision) ? 1 : 0;
      } else {
        const dist = row.event_at <= input.now ? input.now - row.event_at : (row.event_at - input.now) * 1.5;
        timeFit = Math.exp(-dist / (7 * DAY));
      }

      // 情绪同频：心情差时更容易想起难过的卡；而且越情绪化的卡共鸣越强。
      // 这一路的数据（card.valence/arousal）从 v2 起就在库里，只是从来没人读。
      const match = 1 - Math.abs(row.valence - vNow) / 2;
      const emotionalWeight = Math.min(1, (Math.abs(row.valence) + row.arousal) / 1.2);
      const affectFit = input.affect ? match * (0.4 + 0.6 * emotionalWeight) : 0;

      // 社交：未了之事 / 种子 / 实体命中 / 反刍
      const entityHit = overlap(row.entities, queryTokens) > 0 ? 1 : 0;
      const social = ch.loop || ch.seed ? 1 : entityHit ? 0.6 : 0;

      const base =
        WEIGHTS.keyword * ch.fts +
        WEIGHTS.time * timeFit +
        WEIGHTS.strength * row.strength +
        WEIGHTS.salience * row.salience +
        WEIGHTS.affect * affectFit +
        WEIGHTS.social * social;

      // 状态是乘性惩罚，不是加性：0.1 的权重压不住"关键词完全命中"带来的分差，
      // 而"已失效/已改口/玩笑"被当成现状，恰恰是最要命的错误。
      const statusFactor = row.status === "active" ? 1 : row.status === "uncertain" ? 0.85 : 0.55;
      const kindFactor = row.kind === "joke" ? 0.75 : 1;
      // v3：不确定的卡片要付代价。以前 confidence 恒为 1（根本没写进去），
      // 于是"我以为"和"他确认"同权。
      const confFactor = 0.7 + 0.3 * Math.max(0, Math.min(1, row.confidence));

      // 反刍来的卡片给固定中档分：它跟话题无关，不该按相关度算，
      // 但也不能太低 —— 太低就永远进不了提示词，"忽然想起"就白做了。
      const score = ch.sudden
        ? 0.45 * statusFactor
        : base * statusFactor * kindFactor * confFactor;

      const channel = ch.sudden
        ? "sudden"
        : ch.fts > 0
          ? "fts"
          : ch.seed > 0
            ? "seed"
            : ch.loop > 0
              ? "loop"
              : ch.recent > 0
                ? "recent"
                : "time";
      return { row, score, channel };
    })
    .filter((x): x is { row: CardRow; score: number; channel: string } => x !== null)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { cards: [], tokens: 0, query: q, channels };

  // ── 相对截断：只保留和第一名同一量级的候选 ──
  // 没有这一刀，"最近 3 天"通道会稳定贡献 2~3 张 0.4 分的凑数卡片
  // （时间近本身就值 0.20 分），把提示词的卡片预算吃光。
  const top = scored[0]?.score ?? 0;
  const floor = Math.max(0.25, top * 0.55);
  const kept = scored.filter((s) => s.score >= floor);

  // ── 覆盖选择 ──
  const picked = coverSelect(kept, cfg.recall.maxCards);

  // ── 线程展开：带上"前后变化" + 声明过的因果 ──
  const threadIds = [...new Set(picked.map((p) => p.row.thread_id).filter((x): x is number => x !== null))];
  const threadMap = new Map<number, ThreadRow>(getThreads(env.db, threadIds).map((t) => [t.id, t]));
  const expanded: { row: CardRow; score: number; channel: string; fromThread: boolean }[] = picked.map((p) => ({
    ...p,
    fromThread: false,
  }));

  for (const p of picked) {
    // 1) 同一条线上的兄弟
    if (p.row.thread_id) {
      for (const s of threadCards(env.db, p.row.thread_id, p.row.id, cfg.recall.threadSiblings)) {
        if (expanded.some((e) => e.row.id === s.id)) continue;
        expanded.push({ row: s, score: p.score * 0.6, channel: "thread", fromThread: true });
      }
    }
  }

  // 2) 声明过因果的邻居（v3）。哪怕两条卡没被串成线，只要当初写了
  //    "因为 #12，所以这张"，它们就该一起被想起来。
  const pickedIds = picked.map((p) => p.row.id);
  for (const n of linkedNeighbors(env.db, pickedIds, cfg.recall.linkNeighbors)) {
    if (expanded.some((e) => e.row.id === n.id)) continue;
    expanded.push({ row: n, score: (picked[0]?.score ?? 0.4) * 0.55, channel: "link", fromThread: true });
    if (n.thread_id && !threadMap.has(n.thread_id)) {
      for (const t of getThreads(env.db, [n.thread_id])) threadMap.set(t.id, t);
    }
  }
  channels.link = expanded.filter((e) => e.channel === "link").length;
  channels.thread = expanded.filter((e) => e.fromThread).length;

  // 注意：这里**不能**再按时间重排。
  // 之前踩过一次：coverSelect 后的顺序是"分数序"，如果为了"组内按时间近到远"再排一遍，
  // 今天那张无关卡片会顶掉昨天那张真正命中的卡片 —— 排序把检索结果毁了。
  // 线程展开的兄弟卡片一律排在直接命中之后（它们已经 push 在尾部了）。

  // ── token 预算 ──
  const out: RetrievedCard[] = [];
  let tokens = 0;
  for (const e of expanded) {
    const cost = e.row.title.length + e.row.detail.length;
    if (out.length > 0 && tokens + cost > cfg.recall.maxTokens) break;
    tokens += cost;
    const t = e.row.thread_id ? threadMap.get(e.row.thread_id) : undefined;
    out.push(
      toRetrievedCard(
        e.row,
        Number(e.score.toFixed(3)),
        e.channel,
        timeLabelOf(e.row, input.now),
        t ? { title: t.title, summary: t.summary } : null,
        e.fromThread,
      ),
    );
  }

  if (!input.dryRun) {
    logRecall(
      env.db,
      out.map((c) => ({ ts: input.now, turnId: input.turnId, cardId: c.id, score: c.score, channel: c.channel })),
    );
    for (const c of out) boostCard(env.db, c.id, input.now);
  }

  return { cards: out, tokens, query: q, channels };
}

/** 时间窗内的卡片：先粗筛（两端各放宽 14 天），精度容忍度在内存里按 time_precision 判断 */
function cardsInWindow(env: Env, from: number, to: number): CardRow[] {
  const pad = 14 * DAY;
  return env.db
    .prepare(
      `SELECT * FROM card
        WHERE superseded_by IS NULL AND strength > 0.05
          AND event_at BETWEEN ? AND ?
        ORDER BY event_at DESC LIMIT 60`,
    )
    .all(from - pad, to + pad) as unknown as CardRow[];
}

/**
 * 覆盖式选择：先拿最高分；之后每轮优先挑"和已选的不是同一天"的最高分。
 * 目的是让提示词里出现几个不同时间点，而不是同一件事的五个版本。
 *
 * 注意 0.25 的偏好加成是加性的：它意味着"换一天"最多能让一张卡多出 0.25 分。
 * 因为 kept 已经过 floor（≥ max(0.25, top*0.55)），这个加成不会让
 * 明显更弱的卡片顶掉更强的 —— 但它是可调的手感参数，改之前先想清楚。
 */
function coverSelect(
  scored: { row: CardRow; score: number; channel: string }[],
  k: number,
): { row: CardRow; score: number; channel: string }[] {
  const picked: typeof scored = [];
  const usedDays = new Set<string>();
  const pool = [...scored];
  const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);

  while (picked.length < k && pool.length > 0) {
    let bestIdx = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      const fresh = usedDays.has(dayKey(c.row.event_at)) ? 0 : 0.25;
      const val = c.score + fresh;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const chosen = pool.splice(bestIdx, 1)[0];
    picked.push(chosen);
    usedDays.add(dayKey(chosen.row.event_at));
  }
  return picked;
}

/** 卡片的时间标签：优先用原话里的时间词 */
export function timeLabelOf(row: CardRow, now: number): string {
  if (row.event_hint) return row.event_hint;
  const d = Math.floor((now - row.event_at) / DAY);
  if (d < 0) {
    // 未来的事（计划）。说"三天后"比说"今天"诚实。
    const ahead = Math.floor((row.event_at - now) / DAY);
    return ahead <= 0 ? "今天" : ahead === 1 ? "明天" : `${ahead} 天后`;
  }
  if (d <= 0) return "今天";
  if (d === 1) return "昨天";
  if (d === 2) return "前天";
  if (d < 7) return `${d} 天前`;
  if (d < 30) return `${Math.floor(d / 7)} 周前`;
  if (d < 365) return `${Math.floor(d / 30)} 个月前`;
  return "很久以前";
}

/**
 * 第二段回忆：翻原始记录。
 * 优先用卡片存下的 trace 区间；没有就按 episode + 时间点取附近几句。
 */
export function expandCard(env: Env, cardId: number, lines: number): TraceSlice | null {
  const card = getCards(env.db, [cardId])[0];
  if (!card) return null;

  let rows = card.trace_from ? traceRange(env.db, card.trace_from, card.trace_to ?? card.trace_from, lines) : [];
  if (rows.length === 0 && card.episode_id) {
    rows = tracesAround(env.db, card.episode_id, card.event_at, lines);
  }
  if (rows.length === 0) return null;
  return {
    cardId,
    lines: rows.map((r) => ({ role: r.role, content: r.content, ts: r.ts })),
  };
}

// ── 小工具 ─────────────────────────────────────────────────
/** 查询的词元集合（和 FTS 用同一套切词，保证对得上） */
function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s，。！？、,.!?;；:：]+/)
      .filter((t) => t.length >= 2),
  );
}

/** entities 里有几项出现在查询里（子串双向包含，容错写法差异） */
function overlap(entitiesJson: string | null, query: Set<string>): number {
  if (!entitiesJson) return 0;
  let arr: string[];
  try {
    const v = JSON.parse(entitiesJson);
    arr = Array.isArray(v) ? v.map(String) : [];
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of arr) {
    const e2 = e.toLowerCase();
    if (e2.length < 2) continue;
    for (const q of query) if (q.includes(e2) || e2.includes(q)) n++;
  }
  return n;
}

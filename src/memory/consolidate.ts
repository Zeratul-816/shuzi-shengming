/**
 * 巩固（"睡眠"）：把白天的卡片整理一遍。五件事，按顺序：
 *
 *   1. 近重复合并   同 kind 且字面 Dice ≥ 0.62 → 保留更结实的一条，其余软删除
 *   2. 模型判定合并 让便宜模型看标题，抓"自由改写"型重复（字面抓不住的那些）
 *   3. 串线 Thread  优先用**声明过的因果**（card_link），其次才是关键词猜测
 *   4. 归档死账     21 天以上、已提过 ≥2 次的未了之事 → expired
 *   5. 关系与自我   重写对他的印象 / 必要时给自我叙事升一版
 *   6. 时间驱动过期 计划类卡片的时间过去 → expired（memory/status.ts）
 *
 * 第 3 步是 v2 的重点、v3 的痛点：用户要的"理清来龙去脉"，靠的就是 thread。
 * v2 里 thread 是**事后猜**出来的（共享 ≥2 个词元 + 时间接近），
 * 串错和漏串都很难发现。v3 让编码时就把因果声明下来，这里优先采信声明，
 * 猜只用来补漏。
 */
import { z } from "zod";
import type { Env } from "../env.ts";
import type { SelfSheetRow } from "../store/repos.ts";
import { all, run, tx } from "../store/db.ts";
import { insertSelfSheet } from "../store/repos.ts";
import type { CardLinkRow, CardRow, PersonRow, ThreadRow } from "../store/repos.ts";
import {
  activeThreads,
  attachThread,
  countCards,
  createThread,
  getCards,
  liveCardCount,
  refreshThreadStats,
  supersedeCard,
  updateCardFields,
  updatePerson,
  updateThreadSummary,
} from "../store/repos.ts";
import { bigramSet, diceOfSets } from "../store/bigram.ts";
import { chatJson } from "../llm/provider.ts";
import { refreshStatuses } from "./status.ts";

export interface ConsolidateReport {
  cardsBefore: number;
  liveBefore: number;
  liveAfter: number;
  merged: number;
  llmMerged: number;
  threadsFormed: number;
  threadsSummarized: number;
  expiredLoops: number;
  statusExpired: number;
  prunedRecall: number;
  prunedPrompt: number;
  personUpdated: boolean;
  selfSheetBumped: boolean;
  notes: string[];
}

const MERGE_DICE = 0.62;
const SCAN_LIMIT = 300;
const LLM_MERGE_LIMIT = 12;

const MergeGroupsSchema = z.object({
  groups: z.array(z.array(z.number().int())).default([]),
});

const ThreadSummarySchema = z.object({
  title: z.string().min(2).max(24),
  summary: z.string().min(4).max(200),
});

const MERGE_SYSTEM = `你在整理一个助手的记忆卡片。
下面每条是一张卡片的标题，编号从 0 开始。
请找出**说的是同一件事**的编号，分到一组。

规则：
- 只有确实是同一件事/同一个事实才归为一组；话题相近不行。
- 措辞不同但内容相同 → 同组。
- 同一天发生的两件不同的事 → 不同组。
- 找不到就返回空数组。
- 只输出 JSON：{"groups": [[0,3],[1,4,7]]}`;

const THREAD_SYSTEM = `你在帮一个助手整理"某件事的来龙去脉"。
下面按时间从早到晚列出同一主题的几张记忆卡片（标题 + 日期）。
请用 3 句以内写清：最早是什么情况、中间怎么变、现在是什么状态。
如果前后有反转或矛盾，必须点出来。

只输出 JSON：{"title": "不超过 12 字的主题名", "summary": "演变过程"}`;

export async function consolidate(env: Env, now: number): Promise<ConsolidateReport> {
  const notes: string[] = [];
  const cardsBefore = countCards(env.db);
  const liveBefore = liveCardCount(env.db);

  // ── 1. 字面近重复合并 ──
  const pool = all<CardRow>(
    env.db,
    "SELECT * FROM card WHERE superseded_by IS NULL AND strength > 0.05 ORDER BY event_at DESC LIMIT ?",
    [SCAN_LIMIT],
  );
  const tokenSets = pool.map((r) => bigramSet(`${r.title} ${r.detail}`));
  const killed = new Set<number>();
  let merged = 0;

  tx(env.db, () => {
    for (let i = 0; i < pool.length; i++) {
      if (killed.has(pool[i].id)) continue;
      for (let j = i + 1; j < pool.length; j++) {
        if (killed.has(pool[j].id)) continue;
        if (pool[i].kind !== pool[j].kind) continue;
        if (diceOfSets(tokenSets[i], tokenSets[j]) < MERGE_DICE) continue;

        const keep = pool[i].strength * pool[i].salience >= pool[j].strength * pool[j].salience ? pool[i] : pool[j];
        const drop = keep === pool[i] ? pool[j] : pool[i];
        supersedeCard(env.db, drop.id, keep.id);
        updateCardFields(env.db, keep.id, { strength: Math.min(1, keep.strength + drop.strength * 0.5) });
        killed.add(drop.id);
        merged++;
      }
    }
  });
  if (merged > 0) notes.push(`合并了 ${merged} 组字面重复`);

  // ── 2. 模型判定合并（抓自由改写）──
  const llmMerged = await llmMerge(env, now);
  if (llmMerged > 0) notes.push(`模型判定合并 ${llmMerged} 组`);

  // ── 3. 串线 ──
  const threads = formThreads(env, now);
  if (threads.formed > 0) notes.push(`新串成 ${threads.formed} 条线`);
  if (threads.declared > 0) notes.push(`其中 ${threads.declared} 条边是编码时声明过的因果`);
  const summarized = await summarizeThreads(env, now, 2);
  if (summarized > 0) notes.push(`重写了 ${summarized} 条线的演变`);

  // ── 4. 归档死账 ──
  const stale = all<{ id: number }>(
    env.db,
    "SELECT id FROM open_loop WHERE status = 'open' AND created_at < ? AND mentioned_count >= 2",
    [now - 21 * 86_400_000],
  );
  if (stale.length > 0) {
    run(
      env.db,
      "UPDATE open_loop SET status = 'expired', closed_at = ? WHERE status = 'open' AND created_at < ? AND mentioned_count >= 2",
      [now, now - 21 * 86_400_000],
    );
    notes.push(`归档了 ${stale.length} 条过期未了之事`);
  }

  // ── 4.5 时间驱动的状态迁移 ──
  // 放在串线之后、关系之前：先让"已经过去的事"退出 active，
  // 后面的印象重写才不会被一张早就过期的计划卡影响。
  const statusRep = refreshStatuses(env, now);
  if (statusRep.expired > 0) {
    notes.push(`按时间自动失效 ${statusRep.expired} 张（${[...new Set(statusRep.transitions.map((t) => t.reason))].join("、")}）`);
  }

  // ── 4.6 日志生命周期 ──
  // "档案库"如果不清理自己的借阅记录，很快就会比馆藏还大：
  // prompt_log 每条存整份提示词（约 8KB），一天 200 轮就是 1.6MB。
  const pruned = pruneLogs(env, now);
  if (pruned.recall + pruned.prompt > 0) {
    notes.push(`清理日志：召回 ${pruned.recall} 行 / 调用 ${pruned.prompt} 行`);
  }

  // ── 5. 关系与自我 ──
  const person = all<PersonRow>(env.db, "SELECT * FROM person WHERE is_primary = 1 LIMIT 1")[0];
  let personUpdated = false;
  if (person) {
    const top = all<CardRow>(
      env.db,
      `SELECT * FROM card
        WHERE superseded_by IS NULL AND strength > 0.15 AND kind IN ('relation','event','preference')
        ORDER BY strength * salience DESC LIMIT 3`,
    );
    if (top.length > 0) {
      updatePerson(
        env.db,
        person.id,
        { impression: top.map((c) => c.title).join("；").slice(0, 160), closeness: Math.min(1, person.closeness + 0.02) },
        now,
      );
      personUpdated = true;
    }
  }

  const cur = all<SelfSheetRow>(env.db, "SELECT * FROM self_sheet WHERE active = 1 LIMIT 1")[0];
  let selfSheetBumped = false;
  const liveAfter = liveCardCount(env.db);
  if (cur && liveAfter > 0) {
    const strong = all<CardRow>(
      env.db,
      "SELECT * FROM card WHERE superseded_by IS NULL AND kind IN ('self','relation') ORDER BY strength * salience DESC LIMIT 3",
    );
    const append = strong.map((s) => s.title).join("；");
    const summary = (cur.summary + (append ? `　（${append.slice(0, 120)}）` : "")).slice(0, 300);
    if (summary !== cur.summary) {
      insertSelfSheet(env.db, {
        version: cur.version + 1,
        created_at: now,
        summary,
        identity: cur.identity,
        core_values: cur.core_values,
        contradictions: cur.contradictions,
        voice_rules: cur.voice_rules,
        long_goals: cur.long_goals,
        change_note: `巩固自动演进：吸收 ${strong.length} 张最强卡片`,
      });
      selfSheetBumped = true;
      notes.push(`自我叙事升到 v${cur.version + 1}`);
    }
  }

  return {
    cardsBefore,
    liveBefore,
    liveAfter,
    prunedRecall: pruned.recall,
    prunedPrompt: pruned.prompt,
    merged,
    llmMerged,
    threadsFormed: threads.formed,
    threadsSummarized: summarized,
    expiredLoops: stale.length,
    statusExpired: statusRep.expired,
    personUpdated,
    selfSheetBumped,
    notes,
  };
}

/** 让便宜模型判断"这些卡片里有没有在说同一件事"（自由改写型重复的唯一解） */
async function llmMerge(env: Env, now: number): Promise<number> {
  if (env.cfg.provider === "mock") return 0;
  const pool = all<CardRow>(
    env.db,
    `SELECT * FROM card
      WHERE superseded_by IS NULL AND strength > 0.05 AND kind IN ('event','fact','relation','self')
      ORDER BY id DESC LIMIT ?`,
    [LLM_MERGE_LIMIT],
  );
  if (pool.length < 2) return 0;

  try {
    const list = pool.map((r, i) => `${i}. ${r.title}`).join("\n");
    const { value } = await chatJson(
      env.llm,
      {
        kind: "consolidate",
        system: MERGE_SYSTEM,
        user: list,
        temperature: 0,
        maxTokens: 400,
        json: { name: "merge_groups", schema: { type: "object" } },
      },
      MergeGroupsSchema,
      1,
    );
    return applyMergeGroups(
      env,
      pool.map((r) => r.id),
      value.groups,
    );
  } catch (e) {
    console.warn("[consolidate] LLM 合并跳过：", e instanceof Error ? e.message : e);
    return 0;
  }
}

/** 把"同一组"的卡片合成一条：保留最结实的那条，其余软删除 */
export function applyMergeGroups(env: Env, ids: number[], groups: number[][]): number {
  let merged = 0;
  for (const group of groups) {
    if (!Array.isArray(group) || group.length < 2) continue;
    const rows = group
      .map((i) => (Number.isInteger(i) && i >= 0 && i < ids.length ? getCards(env.db, [ids[i]])[0] : undefined))
      .filter((r): r is CardRow => !!r && r.superseded_by === null);
    if (rows.length < 2) continue;

    rows.sort((a, b) => b.strength * b.salience - a.strength * a.salience);
    const keep = rows[0];
    let strength = keep.strength;
    for (const drop of rows.slice(1)) {
      supersedeCard(env.db, drop.id, keep.id);
      strength = Math.min(1, strength + drop.strength * 0.5);
    }
    updateCardFields(env.db, keep.id, { strength });
    merged++;
  }
  return merged;
}

/**
 * 串线。两个依据，优先级不同：
 *
 *   1. **声明过的因果**（card_link）—— 编码时模型指着已有卡片说
 *      "因为那张，所以这张"。这是第一手信息，直接采信。
 *   2. 共享 ≥2 个关键词/实体 + 时间接近 —— 猜的。只用来补漏。
 *
 * v2 只有第 2 种。它的问题不是准不准，是**错了不会报错**：
 * 串错（"上线"和"报错"是两件事共用的词，三个月后会被并成一条线）
 * 和漏串（同一件事换了说法就串不上）都只表现为"它的记忆有点乱"。
 *
 * 用并查集是为了处理传递性（A 像 B，B 像 C，A 却不像 C）。
 */
export function formThreads(env: Env, now: number): { formed: number; attached: number; declared: number } {
  const cards = all<CardRow>(
    env.db,
    `SELECT * FROM card
      WHERE superseded_by IS NULL AND strength > 0.05 AND kind IN ('event','fact','preference','plan')
      ORDER BY event_at DESC LIMIT 120`,
  );
  if (cards.length < 2) return { formed: 0, attached: 0, declared: 0 };

  const tokensOf = (c: CardRow): Set<string> => {
    const kws = [...safeList(c.keywords), ...safeList(c.entities)];
    const fromTitle = [...bigramSet(c.title)];
    return new Set([...kws, ...fromTitle]);
  };
  const sets = cards.map(tokensOf);

  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let p = parent.get(x) ?? x;
    if (p !== x) p = find(p);
    parent.set(x, p);
    return p;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  cards.forEach((c) => parent.set(c.id, c.id));

  // ── 1. 声明的因果（第一依据，优先采信）──
  const inSet = new Set(cards.map((c) => c.id));
  const links = all<CardLinkRow>(env.db, "SELECT * FROM card_link ORDER BY id DESC LIMIT 800");
  let declared = 0;
  for (const l of links) {
    if (!inSet.has(l.from_id) || !inSet.has(l.to_id)) continue;
    if (find(l.from_id) === find(l.to_id)) continue;
    union(l.from_id, l.to_id);
    declared++;
  }

  // ── 2. 关键词/实体撞车（补漏，见函数头说明）──
  const DAY120 = 120 * 86_400_000;
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      if (Math.abs(cards[i].event_at - cards[j].event_at) > DAY120) continue;
      // 共享词元数（排除过短的二元组噪声由 bigramSet 已保证长度≥2）
      let shared = 0;
      const [small, big] = sets[i].size <= sets[j].size ? [sets[i], sets[j]] : [sets[j], sets[i]];
      for (const t of small) {
        if (big.has(t)) shared++;
        if (shared >= 2) break;
      }
      if (shared >= 2) union(cards[i].id, cards[j].id);
    }
  }

  const groups = new Map<number, CardRow[]>();
  for (const c of cards) {
    const root = find(c.id);
    const g = groups.get(root) ?? [];
    g.push(c);
    groups.set(root, g);
  }

  let formed = 0;
  let attached = 0;
  for (const [, g] of groups) {
    if (g.length < 2) continue;
    // 组里已有的 thread 优先复用，没有就新建
    const existing = g.map((c) => c.thread_id).find((t): t is number => typeof t === "number");
    let threadId = existing ?? null;
    if (threadId === null) {
      threadId = createThread(env.db, threadTitleOf(g), now);
      formed++;
    }
    for (const c of g) {
      if (c.thread_id !== threadId) {
        attachThread(env.db, c.id, threadId);
        attached++;
      }
    }
    refreshThreadStats(env.db, threadId);
  }
  return { formed, attached, declared };
}

function threadTitleOf(g: CardRow[]): string {
  const counter = new Map<string, number>();
  for (const c of g) for (const k of [...safeList(c.keywords), ...safeList(c.entities)]) counter.set(k, (counter.get(k) ?? 0) + 1);
  const top = [...counter.entries()].sort((a, b) => b[1] - a[1])[0];
  return (top?.[0] ?? g[0].title).slice(0, 20);
}

/**
 * 给最近变化过的线写"演变"。
 * 每次巩固最多处理 lines 条 —— 这是纯成本控制，写总结的收益随条数迅速递减。
 *
 * 另外只挑"有新卡片进来"的线（last_at > summarized_at）：
 * 巩固常常一天跑好几次，没新内容还重写一遍 = 白花钱，而且会让 summary 每次措辞都变，
 * 反而更难看出来"事情有没有变"。
 */
async function summarizeThreads(env: Env, now: number, lines: number): Promise<number> {
  const threads = activeThreads(env.db, 12)
    .filter((t) => t.card_count >= 2)
    .filter((t) => (t.last_at ?? 0) > (t.summarized_at ?? 0));
  if (threads.length === 0) return 0;
  let done = 0;

  for (const t of threads.slice(0, lines)) {
    const cards = all<CardRow>(
      env.db,
      "SELECT * FROM card WHERE thread_id = ? AND superseded_by IS NULL ORDER BY event_at ASC LIMIT 8",
      [t.id],
    );
    if (cards.length < 2) continue;

    if (env.cfg.provider === "mock") {
      // 桩没有归纳能力，退化成按时间拼接，保证结构可用
      updateThreadSummary(env.db, t.id, t.title, cards.map((c) => c.title).join(" → ").slice(0, 200));
      done++;
      continue;
    }

    try {
      const list = cards
        .map((c) => `${new Date(c.event_at).toISOString().slice(0, 10)} ${c.status === "active" ? "" : `〔${c.status}〕`} ${c.title}`)
        .join("\n");
      const { value } = await chatJson(
        env.llm,
        {
          kind: "consolidate",
          system: THREAD_SYSTEM,
          user: `主题：${t.title}\n${list}`,
          temperature: 0.3,
          maxTokens: 300,
          json: { name: "thread_summary", schema: { type: "object" } },
        },
        ThreadSummarySchema,
        1,
      );
      updateThreadSummary(env.db, t.id, value.title, value.summary);
      done++;
    } catch (e) {
      console.warn("[consolidate] 线程总结跳过：", e instanceof Error ? e.message : e);
    }
  }
  return done;
}

function safeList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** 调试：清掉 mock 期间写下的卡片 */
export function purgeMockCards(env: Env): number {
  const rows = all<{ id: number }>(env.db, "SELECT id FROM card WHERE keywords LIKE '%mock%'");
  tx(env.db, () => {
    for (const r of rows) run(env.db, "DELETE FROM card WHERE id = ?", [r.id]);
  });
  return rows.length;
}

/**
 * 日志保留策略：召回日志 90 天，调用日志 30 天。
 * 两者都是"调试证据"，不是记忆本身 —— 过了期限，价值远低于它占的空间。
 */
function pruneLogs(env: Env, now: number): { recall: number; prompt: number } {
  const DAY = 86_400_000;
  const recall = env.db
    .prepare("DELETE FROM recall_log WHERE ts < ?")
    .run(now - 90 * DAY).changes as number;
  const prompt = env.db
    .prepare("DELETE FROM prompt_log WHERE ts < ?")
    .run(now - 30 * DAY).changes as number;
  return { recall: Number(recall), prompt: Number(prompt) };
}

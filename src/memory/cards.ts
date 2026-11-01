/**
 * 卡片化：把一次主观编码拆成若干张卡片写进库。
 *
 * 与 v1 的"原子"相比，变化不在粒度，而在**每张卡都要回答三个问题**：
 *   1. 什么时候的事（event_at / time_precision）
 *   2. 现在还成立吗（status：active / expired / retracted / uncertain）
 *   3. 以后怎么找它（keywords / entities）
 * 这三项是检索的全部依据。没有它们，卡片就只是聊天记录的复述。
 *
 * ── v3 新增两条 ──────────────────────────────────────────
 *   · **视角**：attention / meant_to_me 落库。以前这两个字段每轮由模型生成、
 *     每轮被丢弃 —— 于是所有卡片都是"完整观察者"写的摘要，没有"她注意到什么"。
 *   · **因果**：卡片可以指认已有卡片（links）。串线从此有了第一手依据，
 *     不再只靠 consolidate 里"关键词撞上就算一条线"的猜测。
 *
 * 去重：字面 Dice ≥ 0.62 视为同一件事（标定见 store/bigram.ts）。
 * 没有向量，也就不存在"语义相近但字面完全不同"的自动合并 —— 那一层交给
 * 巩固阶段的 LLM 判定（memory/consolidate.ts）。
 */
import type { Env } from "../env.ts";
import type { Appraisal, CardKind, CardStatus } from "../shared/types.ts";
import { all } from "../store/db.ts";
import type { CardRow } from "../store/repos.ts";
import {
  addOpenLoop,
  getCard,
  insertCard,
  linkCards,
  supersedeCard,
  updateCardFields,
  type NewCard,
} from "../store/repos.ts";
import { bigramDice } from "../store/bigram.ts";
import { parseEventAt } from "../shared/timeparse.ts";
import { resolveCardSubject } from "./person.ts";

const LEXICAL_DUP = 0.62; // 判重（标题+正文的整体重合）
/**
 * 标题级判重：标题几乎一样就是同一件事，不看正文。
 *
 * ★ 为什么要单独一条：真机上跑出过两张标题一模一样的 self 卡
 *   （「他问我是什么样的人，我答「能干的」」），但两次的 detail 措辞差得多，
 *   整体 Dice 掉到 0.62 以下，于是各写一张。
 *   标题本来就是"这件事叫什么"，它比正文稳定得多 —— 拿它当第一判据更可靠。
 *   合并的代价只是强度 +0.15，漏判的代价是库里长出一片近重复。
 */
const TITLE_DUP = 0.88;
const LEXICAL_NEAR_IDENTICAL = 0.85; // 近乎逐字重复：不开新版本
const CANDIDATE_SCAN = 200; // 判重时比对的最近卡片数

export interface WriteContext {
  now: number;
  episodeId: number;
  /** 默认归属人：正在跟我说话的那个人 */
  personId: number;
  /** 本轮提到的其他人（name → personId），来自 Appraisal.people */
  peopleMap?: Map<string, number>;
  /** 本轮原始记录的 trace id 区间，卡片要记住它才能翻页 */
  traceFrom: number | null;
  traceTo: number | null;
}

export interface WriteResult {
  inserted: number;
  merged: number;
  rewritten: number;
  openLoops: number;
  links: number;
  ids: number[];
  /** 这一轮动过的档案（要重算 traits/impression） */
  peopleTouched: number[];
}

/** salience = 0.30*自我相关 + 0.25*情绪强度 + 0.20*新鲜 + 0.15*他的信号 + 0.10*目标相关 */
export function computeSalience(a: Appraisal): number {
  const intensity = (Math.abs(a.felt.valence) + a.felt.arousal) / 2;
  return clamp01(
    0.3 * a.scores.self_relevance +
      0.25 * intensity +
      0.2 * a.scores.novelty +
      0.15 * a.scores.user_signal +
      0.1 * a.scores.goal_relevance,
  );
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** 一张卡片用于判重的文本：标题 + 正文 */
function dupText(title: string, detail: string): string {
  return `${title} ${detail}`;
}

export async function writeCards(env: Env, appraisal: Appraisal, ctx: WriteContext): Promise<WriteResult> {
  const result: WriteResult = { inserted: 0, merged: 0, rewritten: 0, openLoops: 0, links: 0, ids: [], peopleTouched: [] };
  const peopleMap = ctx.peopleMap ?? new Map<string, number>();
  const drafts = (appraisal.cards ?? []).filter((d) => d.title.trim().length >= 4 && d.detail.trim().length >= 6);
  if (drafts.length === 0) {
    result.openLoops = addLoops(env, appraisal, ctx);
    return result;
  }

  const salience = computeSalience(appraisal);
  // 判重候选：最近的卡片。200 条足够覆盖"刚才说过同一件事"的场景。
  const candidates = all<CardRow>(
    env.db,
    "SELECT * FROM card WHERE superseded_by IS NULL AND strength > 0.05 ORDER BY id DESC LIMIT ?",
    [CANDIDATE_SCAN],
  );

  /**
   * 陈旧的视角守卫。
   *
   * 编码器看到的是"最近 10 轮"，于是它常常把**上一轮**注意到的东西当成这一轮的。
   * 真机上出现过连续几张卡片带着同一句 attention。
   *
   * ★ 这条是**内容层面**的整理，不是正确性要求 —— 一个人连着几个瞬间注意到
   *   同一件事，本来就正常。留着它的理由只有一条：同一句话被逐字印在新卡上时，
   *   读起来像 bug 而不像人。删掉它不会破坏任何机制。
   *
   * 处理方式：和上一张卡片几乎一样就丢掉这一步的 attention。
   * （meant_to_me 不这么做：它对同一件事确实可能一直成立。）
   */
  const lastAttention = candidates[0]?.attention ?? null;
  const freshAttention =
    appraisal.attention && lastAttention && bigramDice(appraisal.attention, lastAttention) >= 0.8
      ? ""
      : appraisal.attention;
  const safeAppraisal = { ...appraisal, attention: freshAttention };

  for (const draft of drafts) {
    const parsed = parseEventAt(draft.event_at_iso, ctx.now);
    const precision = draft.time_precision ?? parsed.precision;
    const text = dupText(draft.title, draft.detail);
    // 这张卡是关于谁的：留空 = 他；命中别名 = 那个人
    const subject = resolveCardSubject(env, draft, ctx.personId, peopleMap);
    if (!result.peopleTouched.includes(subject)) result.peopleTouched.push(subject);

    // ── 判重 ──
    // 两个判据取更宽的那个：整体重合度，或标题几乎相同。
    let best: { row: CardRow; dice: number } | null = null;
    for (const c of candidates) {
      if (result.ids.includes(c.id)) continue;
      if (c.kind !== (draft.kind ?? "event")) continue;
      const body = bigramDice(text, dupText(c.title, c.detail));
      const head = bigramDice(draft.title, c.title);
      const dice = Math.max(body, head >= TITLE_DUP ? 1 : body);
      if (!best || dice > best.dice) best = { row: c, dice };
    }

    if (best && best.dice >= LEXICAL_DUP) {
      const old = getCard(env.db, best.row.id);
      if (old && old.superseded_by === null) {
        const nearIdentical = best.dice >= LEXICAL_NEAR_IDENTICAL;
        const newIsRicher = !nearIdentical && draft.detail.trim().length > old.detail.trim().length + 10;
        if (newIsRicher) {
          const id = insertCard(env.db, toNewCard(draft, safeAppraisal, ctx, salience, parsed.at, precision, old, subject));
          supersedeCard(env.db, old.id, id);
          result.inserted++;
          result.rewritten++;
          result.ids.push(id);
          result.links += attachLinks(env, id, draft.links ?? [], candidates);
        } else {
          // 同一件事又被提起：复述强化，只加强度
          updateCardFields(env.db, old.id, { strength: Math.min(1, old.strength + 0.15) });
          result.merged++;
          result.ids.push(old.id);
          // 合并也要收因果：同一件事的新一次讲述，可能第一次说清了"因为什么"
          result.links += attachLinks(env, old.id, draft.links ?? [], candidates);
        }
        continue;
      }
    }

    const id = insertCard(env.db, toNewCard(draft, safeAppraisal, ctx, salience, parsed.at, precision, null, subject));
    result.inserted++;
    result.ids.push(id);
    const fresh = getCard(env.db, id);
    if (fresh) candidates.unshift(fresh);
    result.links += attachLinks(env, id, draft.links ?? [], candidates);
  }

  env.db
    .prepare("UPDATE episode SET card_count = card_count + ? WHERE id = ?")
    .run(result.inserted, ctx.episodeId);

  result.openLoops = addLoops(env, appraisal, ctx);
  return result;
}

/**
 * 把模型声明的因果写进 card_link。
 * 必须做存在性校验：模型会编编号（尤其是指向被 supersede 掉的旧卡时），
 * 而外键约束只保证"这一行存在"，不保证"这个 id 在本次上下文里出现过"。
 * 编错一条不会炸，但会在串线时把两条无关的事绑在一起 —— 静默的错误最难查。
 */
function attachLinks(
  env: Env,
  fromId: number,
  links: { card_id: number; relation: string }[],
  known: CardRow[],
): number {
  if (links.length === 0) return 0;
  const knownIds = new Set(known.map((c) => c.id));
  const valid = links
    .filter((l) => Number.isInteger(l.card_id) && l.card_id !== fromId && knownIds.has(l.card_id))
    .map((l) => ({ toId: l.card_id, relation: l.relation }));
  if (valid.length === 0) return 0;
  return linkCards(env.db, fromId, valid, Date.now());
}

function toNewCard(
  draft: Appraisal["cards"][number],
  appraisal: Appraisal,
  ctx: WriteContext,
  salience: number,
  eventAt: number,
  precision: NewCard["timePrecision"],
  prev: CardRow | null,
  personId: number,
): NewCard {
  return {
    kind: (draft.kind ?? "event") as CardKind,
    status: (draft.status ?? "active") as CardStatus,
    title: draft.title.trim(),
    detail: draft.detail.trim(),
    personId,
    eventAt,
    eventHint: draft.event_hint ?? null,
    timePrecision: precision,
    validFrom: prev?.valid_from ?? null,
    validTo: null,
    keywords: draft.keywords ?? [],
    entities: draft.entities ?? [],
    salience: Math.max(draft.salience ?? salience, prev?.salience ?? 0),
    valence: appraisal.felt.valence,
    arousal: appraisal.felt.arousal,
    confidence: draft.confidence ?? 1,
    threadId: prev?.thread_id ?? null,
    episodeId: ctx.episodeId,
    traceFrom: ctx.traceFrom,
    traceTo: ctx.traceTo,
    notKnown: appraisal.not_known || null,
    // 视角：我注意到的那一部分 / 这对我意味着什么。
    // 两者都是整轮的，不是单卡的 —— 一次经历里"我的注意力"只有一份。
    attention: appraisal.attention || prev?.attention || null,
    meantToMe: appraisal.meant_to_me || prev?.meant_to_me || null,
  };
}

function addLoops(env: Env, appraisal: Appraisal, ctx: WriteContext): number {
  const loops = (appraisal.open_loops ?? []).filter((l) => l.text.trim().length >= 3);
  if (loops.length === 0) return 0;
  let n = 0;
  for (const l of loops) {
    addOpenLoop(env.db, {
      createdAt: ctx.now,
      text: l.text.trim(),
      dueHint: l.due_hint ?? null,
      personId: ctx.personId,
      urgency: l.urgency ?? 0.4,
      cardId: null,
    });
    n++;
  }
  return n;
}

/**
 * 一拍动机。默认每 30 秒跑一次（DH_TICK_MS），纯计算，不调模型。
 *
 * ── 两条路径 ─────────────────────────────────────────────
 *   被动（pendingReply）：他在说话。
 *       不判断"想不想说"——人被叫了不接才是不礼貌。
 *       但**接法**有五种（ask_identity / refuse_care / deflect / test_self / reply），
 *       由 motivation/intents.ts 的 REPLY_TEMPLATES 按身份、需求和语气选。
 *       v2 这里写死一个 `reply`，所以 95% 的轮次都是同一张卡。
 *
 *   主动：由定时器驱动。
 *       1. drift()              需求线性累积、情绪回归基线（见 state.ts）
 *       2. 候选集               intents.ts 里所有 precondition 通过的模板，逐个打分
 *       3. 迟滞计数             只有当拍冠军 streak+1，其余全部清零
 *       4. 三道闸门（全部通过才开口）
 *            · gate ≥ 0.45       （张力空间里"够不够渴"，与权重无关）
 *            · 连续两拍领先       （或 urgency > 0.85 的紧急例外）
 *            · 距上次主动 ≥ 40 分钟
 *       5. 放行                 写冷却（每个 intent 独立）、更新 lastProactiveAt、出卡
 *       6. 落日志               每一拍都写 motivation_tick，含被压制的原因
 *
 * ── 为什么"被压制的原因"要分档 ────────────────────────────
 *   /state 会显示这些原因。调动机手感时你看到的不是"它为什么说了"，
 *   而是"它为什么没说"。v2 把"前置条件不满足""构建失败""冷却中"三种情况
 *   一律记成"冷却中"，于是这个仪表盘会骗人 —— 你会去调冷却时间，
 *   而真正卡住的是阈值。诊断数据错了比没有更糟。
 *
 * ── 沉默是一等公民 ──────────────────────────────────────
 *   card === null 是合法返回，不是错误。被动回复场景里沉默率应为 0，
 *   主动场景里建议维持在 60% 以上（即大多数拍都不该开口）。
 *
 * ── 冷却与全局间隔的区别 ────────────────────────────────
 *   冷却（COOLDOWN_MS，每意图独立）：防止同一件事反复说（follow_up 20min）。
 *   全局间隔（40min）：防止不同意图接力刷屏。两者是不同的病，别合并成一个数。
 */
import type { Db } from "../store/db.ts";
import type { MotivationCard, MotivationState, Need, UserRead } from "../shared/types.ts";
import type { OpenLoopRow } from "../store/repos.ts";
import { logTick } from "../store/repos.ts";
import { dominantNeed, drift, saveState, tension } from "./state.ts";
import { evaluate, evaluateReply, INTENT_TEMPLATES, PROACTIVE_GATE } from "./intents.ts";
import type { IntentCandidate } from "../shared/types.ts";

export interface TickInput {
  now: number;
  /** 距用户上次发言的毫秒数 */
  userIdleMs: number;
  /** 最近是否一直在原地打转（没有新信息） */
  starvedForNovelty: boolean;
  openLoops: OpenLoopRow[];
  /** 有用户消息等待回应 → 走被动回应路径，不做主动决策 */
  pendingReply: boolean;
  /** 他这句话的规则解读（被动路径选意图用）。主动路径传 readUserTurn("") */
  read: UserRead;
  /**
   * 身份状态。不传 = 当成已经知道是谁（老调用方/单测的默认）。
   * 真机上 Brain 每轮都会传，因为"每次醒来谈话对象都待定"。
   */
  identity?: { shouldAsk: boolean; known: boolean; askedCount: number };
}

export interface RejectedCandidate {
  intent: string;
  score: number;
  reason: string;
}

export interface TickOutput {
  state: MotivationState;
  card: MotivationCard | null;
  rejected: RejectedCandidate[];
  proactive: boolean;
  /** 这一拍的闸门数值，/state 和评测都用得上 */
  debug?: { top: string | null; score: number; gate: number; hysteresisOk: boolean; globalBlocked: boolean };
}

const PROACTIVE_GLOBAL_GAP_MS = 40 * 60_000;
const COOLDOWN_MS: Record<string, number> = {
  follow_up: 20 * 60_000,
  persuade: 25 * 60_000,
  ask_help: 30 * 60_000,
  reach_out: 40 * 60_000,
  probe: 30 * 60_000,
  confide: 15 * 60_000,
  seek_validation: 25 * 60_000,
  claim_agency: 45 * 60_000,
  withdraw: 20 * 60_000,
};

const BASE_MUST_NOT = ["复述他刚说过的话", "给没被问的建议", "说「根据我的记忆」"];

function loopWarnings(loops: OpenLoopRow[]): string[] {
  return loops
    .filter((l) => l.mentioned_count >= 3 && l.escalation <= 1)
    .map((l) => `别再追问「${l.text.slice(0, 10)}」（已经提过 ${l.mentioned_count} 次）`);
}

/**
 * 被动回应路径。
 * v3 起它不是"一张固定的 reply 卡"，而是从 REPLY_TEMPLATES 里选出来的。
 * 无论选到哪个，`intent` 会告诉表达层"这一轮我想干什么"，而不是只有语气差别。
 */
export function buildReplyCard(
  state: MotivationState,
  loops: OpenLoopRow[],
  read: UserRead,
  identity?: { shouldAsk: boolean; known: boolean; askedCount: number },
): MotivationCard {
  const { candidate } = evaluateReply({
    now: Date.now(),
    state,
    read,
    openLoops: loops,
    lastIntent: state.lastIntent,
    identity: identity ?? { shouldAsk: false, known: true, askedCount: 0 },
  });
  return {
    intent: candidate.intent,
    drive: candidate.drive,
    urgency: Number(candidate.urgency.toFixed(3)),
    why: candidate.why,
    desired_outcome: candidate.desired_outcome,
    must_include: candidate.must_include,
    must_not: [...candidate.must_not, ...loopWarnings(loops)],
    tone: candidate.tone,
    max_sentences: candidate.max_sentences,
    seed_card_ids: candidate.seed_card_ids,
    attempt: candidate.attempt,
  };
}

/**
 * 一拍动机。纯计算，不调模型，成本为 0。
 * 返回 null 表示"此刻不想说话"——沉默是一等公民。
 */
export function tick(db: Db, state: MotivationState, input: TickInput): TickOutput {
  const s = drift(state, input.now);
  const rejected: RejectedCandidate[] = [];

  if (input.pendingReply) {
    const card = buildReplyCard(s, input.openLoops, input.read, input.identity);
    s.lastIntent = card.intent;
    s.updatedAt = input.now;
    saveState(db, s);
    logTick(db, {
      ts: input.now,
      needs: s.needs,
      affect: s.affect,
      chosen: card.intent,
      urgency: card.urgency,
      score: candidateScore(s, card.urgency, card.intent),
      rejected: [],
      card,
    });
    return {
      state: s,
      card,
      rejected: [],
      proactive: false,
      debug: { top: card.intent, score: 0, gate: 0, hysteresisOk: true, globalBlocked: false },
    };
  }

  const ctx = {
    now: input.now,
    state: s,
    openLoops: input.openLoops,
    userIdleMs: input.userIdleMs,
    starvedForNovelty: input.starvedForNovelty,
  };

  const candidates: IntentCandidate[] = [];
  for (const t of INTENT_TEMPLATES) {
    const r = evaluate(t, ctx);
    if (r.candidate) candidates.push(r.candidate);
    else rejected.push({ intent: t.intent, score: 0, reason: r.reason ?? "未知" });
  }
  candidates.sort((a, b) => b.score - a.score);

  // 更新连任计数：只有当拍冠军才累加，其余清零。
  // 注意这里的自增发生在"读数之前"，是刻意的，但很容易看错：
  //   第一拍  streak 0 → 1，下面判 >=2 不成立 → 压住
  //   第二拍  streak 1 → 2，下面判 >=2 成立   → 放行
  // 所以"连续两拍领先"是靠这两个位置配合出来的。想改成"三拍"就同时改这里的判定值；
  // 只改一边会导致永远开不了口，或者第一拍就开口。
  const top = candidates[0];
  for (const t of INTENT_TEMPLATES) {
    s.streak[t.intent] = top && top.intent === t.intent ? (s.streak[t.intent] ?? 0) + 1 : 0;
  }

  // 全局间隔：不同的意图接力刷屏也算刷屏，所以这道闸门与下面的 per-intent 冷却是两回事
  const globalBlocked = input.now - s.lastProactiveAt < PROACTIVE_GLOBAL_GAP_MS;
  const streakNow = top ? (s.streak[top.intent] ?? 0) : 0;
  const hysteresisOk = streakNow >= 2;
  // 紧急例外：刚到期就该兑现的事不该被迟滞耽误（典型是已经过期的 follow_up）
  const urgentException = top ? top.urgency > 0.85 : false;
  // 门槛与排序分开：weight 只影响谁优先，gate 只回答"这个需求够不够渴"
  const gate = top ? tension(top.urgency) * (streakNow >= 1 ? 1 : 0.55) : 0;
  const accepted = !!top && gate >= PROACTIVE_GATE && !globalBlocked && (hysteresisOk || urgentException);

  let card: MotivationCard | null = null;
  if (top && !accepted) {
    const reason = globalBlocked
      ? "全局主动间隔未到（40 分钟）"
      : !hysteresisOk && !urgentException
        ? "迟滞：还没连续两拍领先"
        : `张力 ${gate.toFixed(2)} 未过门槛 ${PROACTIVE_GATE}`;
    rejected.unshift({ intent: top.intent, score: top.score, reason });
  }

  if (accepted && top) {
    card = {
      intent: top.intent,
      drive: top.drive,
      urgency: Number(top.urgency.toFixed(3)),
      why: top.why,
      desired_outcome: top.desired_outcome,
      must_include: top.must_include,
      must_not: [...top.must_not, ...loopWarnings(input.openLoops)],
      tone: top.tone,
      max_sentences: top.max_sentences,
      seed_card_ids: top.seed_card_ids,
      attempt: top.attempt,
    };
    s.lastProactiveAt = input.now;
    s.lastIntent = top.intent;
    s.cooldowns[top.intent] = input.now + (COOLDOWN_MS[top.intent] ?? 20 * 60_000);
  }

  s.updatedAt = input.now;
  saveState(db, s);
  logTick(db, {
    ts: input.now,
    needs: s.needs,
    affect: s.affect,
    chosen: card?.intent ?? null,
    urgency: card?.urgency ?? null,
    score: top?.score ?? null,
    rejected,
    card,
  });

  return {
    state: s,
    card,
    rejected,
    proactive: true,
    debug: {
      top: top?.intent ?? null,
      score: top?.score ?? 0,
      gate,
      hysteresisOk,
      globalBlocked,
    },
  };
}

/** 被动路径也记一个分数，只为让日志有可比性 */
function candidateScore(_s: MotivationState, urgency: number, intent: string): number {
  const weight = intent === "refuse_care" ? 1.05 : intent === "deflect" ? 0.95 : intent === "test_self" ? 0.9 : 0.62;
  return Number((tension(urgency) * weight).toFixed(3));
}

export function needsTable(needs: Record<Need, number>): string {
  return (Object.keys(needs) as Need[])
    .map((n) => {
      const v = needs[n];
      const bar = "█".repeat(Math.round(v * 20)).padEnd(20, "·");
      return `  ${n.padEnd(11, " ")} ${bar} ${v.toFixed(2)}  (张力 ${tension(v).toFixed(2)})`;
    })
    .join("\n");
}

/**
 * 状态的时间驱动迁移 —— `status` 的第二个写入者。
 *
 * ── 为什么必须有这个文件 ──────────────────────────────────
 *   v2 里 `status` 只有一个写入者：appraiser。也就是说一张卡"还成不成立"
 *   完全取决于**下一次提到它时模型怎么判断**。于是最原始的病灶从来没被治：
 *   「他说下周三要去出差」写成一张 active 的 plan 卡，那一周过去之后，
 *   它仍然是 active、仍然满分时间契合（event_at 在未来时 timeFit=1），
 *   再过一个月它会被当成"他下周要出差"说出来。
 *
 *   这不是模型不够聪明，是缺一个不看对话、只看时钟的东西。
 *
 * ── 两条规则，都很保守 ───────────────────────────────────
 *   1. valid_to 过期        —— 任何带明确有效期的卡片
 *   2. plan 的时间过去了    —— 计划类卡片在 event_at 之后（含宽限）自动失效
 *
 *   刻意**不**做的：
 *   · 不碰 fact/preference/relation —— 一条稳定事实不会因为时间流逝变假
 *   · 不碰 joke —— 玩笑永远是玩笑，它的 kind 已经说明了
 *   · 不碰 uncertain —— 当时就没定，时间也不会替它定
 *   · 不删卡片，只改 status —— 旧卡留着，检索时按乘性惩罚降权（见 retrieve.ts）
 *
 *   保守是对的：误判"已失效"会让它忘记仍然成立的事，比漏判更伤。
 *   所以每条规则的宽限期都往长里给，宁可晚一天失效，不要早一天。
 *
 * ── 谁调用它 ─────────────────────────────────────────────
 *   Brain 构造时（启动一次）、巩固时（/sleep）。
 *   都是"低频、非实时"的时机 —— 状态不需要秒级准确，它需要的是**一定会发生**。
 */
import type { Env } from "../env.ts";
import type { CardRow } from "../store/repos.ts";
import { all, get } from "../store/db.ts";
import { setCardStatus } from "../store/repos.ts";

const DAY = 86_400_000;

/** 计划类卡片的宽限：当天仍然算"今天要去"，跨过两天才认定过去了 */
export const PLAN_GRACE_MS = 2 * DAY;

export interface StatusTransition {
  cardId: number;
  title: string;
  from: string;
  to: string;
  reason: string;
}

export interface StatusRefreshReport {
  scanned: number;
  expired: number;
  transitions: StatusTransition[];
}

/**
 * 扫一遍"可能该过期"的卡片并迁移状态。
 * 只扫 active 且（是 plan 或有 valid_to）的卡，不碰已经失效的。
 */
export function refreshStatuses(env: Env, now: number): StatusRefreshReport {
  const rows = all<CardRow>(
    env.db,
    `SELECT * FROM card
      WHERE superseded_by IS NULL
        AND status = 'active'
        AND (kind = 'plan' OR valid_to IS NOT NULL)
      ORDER BY event_at ASC`,
  );

  const transitions: StatusTransition[] = [];

  for (const r of rows) {
    const reason = whyExpired(r, now);
    if (!reason) continue;
    setCardStatus(env.db, r.id, "expired", reason, now);
    transitions.push({ cardId: r.id, title: r.title, from: "active", to: "expired", reason });
  }

  return { scanned: rows.length, expired: transitions.length, transitions };
}

/** 返回失效理由；不该失效就返回 null */
export function whyExpired(r: CardRow, now: number): string | null {
  // 规则 1：明确写了有效期
  if (r.valid_to !== null && r.valid_to <= now) {
    return "有效期已过（valid_to）";
  }
  // 规则 2：计划类卡片的时间点已经过去
  // 注意 event_at 是"事情发生/要发生"的时间，对 plan 来说就是计划执行的时间。
  // 一张"下周三出差"的卡，event_at 是下周三 —— 过了下周三 + 宽限，计划就该收尾。
  if (r.kind === "plan" && r.event_at + PLAN_GRACE_MS < now) {
    return "计划的时间已经过去";
  }
  return null;
}

/**
 * 调试/评测用：不写库，只告诉他"如果现在跑，哪些会被判过期"。
 * 评测脚本需要它 —— 否则跑一次评测就把库改了。
 */
export function previewExpirations(env: Env, now: number): StatusTransition[] {
  const rows = all<CardRow>(
    env.db,
    `SELECT * FROM card
      WHERE superseded_by IS NULL AND status = 'active' AND (kind = 'plan' OR valid_to IS NOT NULL)`,
  );
  const out: StatusTransition[] = [];
  for (const r of rows) {
    const reason = whyExpired(r, now);
    if (reason) out.push({ cardId: r.id, title: r.title, from: "active", to: "expired", reason });
  }
  return out;
}

/** 手工改正：`/status 12 expired` 用。人比模型更可信，这个入口必须有。 */
export function forceStatus(env: Env, cardId: number, to: string, now: number): boolean {
  const row = get<{ id: number }>(env.db, "SELECT id FROM card WHERE id = ?", [cardId]);
  if (!row) return false;
  setCardStatus(env.db, cardId, to, "手工改正（/status）", now);
  return true;
}

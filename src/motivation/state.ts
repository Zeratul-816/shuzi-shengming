/**
 * 需求动力学：六个稳态需求 + 一个快变情绪。纯数学，不碰 LLM。
 *
 * ── 漂移（need 随时间的"欠账累积"）─────────────────────────
 *   dNeed/dt = NEED_DRIFT[n]，即每秒涨多少。
 *   数值取法：NEED_DRIFT[n] = 1 / 涨满所需秒数，所以常数直接读作"多久会渴"：
 *     connection 5.5h · expression 4h · rest 6h · curiosity 8h
 *     autonomy  10h  · competence 12h
 *   为什么用线性而不是指数：需求是欠账，欠账按时间线性累积。指数会让低位阶段
 *   几乎不动，观感上是"它一直没情绪"；线性则保证从 0.2 到 0.7 是一段看得见的爬升。
 *
 * ── 情绪（快变量，90 秒时间常数）───────────────────────────
 *   affect 向 affectBaseline(needs) 指数回归，tau = 90s。
 *   基线本身由需求算出：长期缺联结（connection 高）→ 基线效价被拉低，
 *   缺休息（rest 高）→ 唤醒与支配一起降。这样"心情"有稳态依据，
 *   不是每轮随机抖动。单次事件的冲击由 nudgeAffect 叠加，随后自然衰减回去。
 *
 * ── 张力（tension）────────────────────────────────────────
 *   tension = 0.55·need + 0.45·need^1.6（混合式，见下方 tensionOf 的说明）。
 *   指数项是刻意的：它放大"很渴"与"有点渴"的**比值**，让 0.9 压过 0.6，
 *   而不是让两者按线性打平。想让动机更偏执就把 1.6 调大，想更磨平就调向 1.0。
 *
 * ── 满足（satisfy）────────────────────────────────────────
 *   一次交互按 SATISFY_AMOUNT 回吐；回吐来源是 appraiser 返回的 satisfies 列表
 *   加 brain.ts 里"被回应本身满足联结"那一条。数值就是"一次够不够解渴"的手感参数。
 *
 * ── 持久化 ───────────────────────────────────────────────
 *   整份 MotivationState 序列化成一行 JSON 存在 meta 表里（key=motivation_state）。
 *   单行状态、读写都是原子的，不值得为它开一张表。
 */
import type { Db } from "../store/db.ts";
import { getMetaJson, setMetaJson } from "../store/db.ts";
import type { AffectState, MotivationState, Need } from "../shared/types.ts";
import { NEEDS } from "../shared/types.ts";

export const STATE_KEY = "motivation_state";

/** 需求漂移速率（每秒）。数值 ≈ 1 / 涨满所需秒数，见 docs 5.2 */
export const NEED_DRIFT: Record<Need, number> = {
  connection: 1 / (5.5 * 3600),
  curiosity: 1 / (8 * 3600),
  expression: 1 / (4 * 3600),
  competence: 1 / (12 * 3600),
  autonomy: 1 / (10 * 3600),
  rest: 1 / (6 * 3600),
};

/** 需求被满足时的回吐量 */
export const SATISFY_AMOUNT: Record<Need, number> = {
  connection: 0.25,
  curiosity: 0.2,
  expression: 0.25,
  competence: 0.2,
  autonomy: 0.2,
  rest: 0.3,
};

export function defaultState(now: number): MotivationState {
  return {
    needs: {
      connection: 0.22,
      curiosity: 0.25,
      expression: 0.2,
      competence: 0.18,
      autonomy: 0.16,
      rest: 0.12,
    },
    affect: { v: 0.1, a: 0.3, d: 0.5 },
    cooldowns: {},
    lastProactiveAt: 0,
    streak: {},
    updatedAt: now,
  };
}

export function loadState(db: Db, now: number): MotivationState {
  const s = getMetaJson<MotivationState>(db, STATE_KEY);
  if (!s || !s.needs || !s.affect) return defaultState(now);
  // 兼容旧版字段缺失
  for (const n of NEEDS) if (typeof s.needs[n] !== "number") s.needs[n] = 0.2;
  return s;
}

export function saveState(db: Db, s: MotivationState): void {
  setMetaJson(db, STATE_KEY, s);
}

function clamp(n: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, n));
}

/** 情绪回归基线：基线本身由需求决定（长期缺联结 → 基线偏冷） */
export function affectBaseline(needs: Record<Need, number>): AffectState {
  return {
    v: clamp(0.12 + 0.25 * needs.connection - 0.3 * needs.rest, -1, 1),
    a: clamp(0.22 + 0.3 * needs.curiosity + 0.2 * needs.expression),
    d: clamp(0.4 + 0.2 * needs.autonomy - 0.25 * needs.rest),
  };
}

/** 一拍：需求漂移 + 情绪回归。纯计算，不调模型。 */
export function drift(state: MotivationState, now: number): MotivationState {
  const dt = Math.max(0, Math.min(3600, (now - state.updatedAt) / 1000));
  if (dt === 0) return state;

  for (const n of NEEDS) {
    state.needs[n] = clamp(state.needs[n] + NEED_DRIFT[n] * dt);
  }

  const base = affectBaseline(state.needs);
  const k = 1 - Math.exp(-dt / 90); // tau = 90s
  state.affect = {
    v: state.affect.v + (base.v - state.affect.v) * k,
    a: state.affect.a + (base.a - state.affect.a) * k,
    d: state.affect.d + (base.d - state.affect.d) * k,
  };
  state.updatedAt = now;
  return state;
}

export function satisfy(state: MotivationState, need: Need, times = 1): void {
  state.needs[need] = clamp(state.needs[need] - SATISFY_AMOUNT[need] * times);
}

export function nudgeAffect(state: MotivationState, v: number, a: number): void {
  state.affect.v = clamp(state.affect.v + v * 0.3, -1, 1);
  state.affect.a = clamp(state.affect.a + a * 0.3);
}

/**
 * 张力：指数放大，让"很渴"压过"有点渴"。
 *
 * ★ v3 修：这个函数以前**算了但没人用**（tick 传进 scoreCandidate，函数体里
 *   那个参数一次都没读过）。文档说"0.9 的需求 ≈ 0.84，0.6 的需求 ≈ 0.44"，
 *   指的是纯 n^1.6。现在真的接上了，但**不能**直接用纯指数：
 *   · 纯 n^1.6 会把所有分数整体压低（0.7 需求从 0.7 掉到 0.565），
 *     而开口门槛 0.55 是按原始值标定的，于是所有意图一起开不了口；
 *   · 混合式 0.55n + 0.45n^1.6 保留了绝对量级（n=0.9 时 ≈0.90），
 *     同时放大了**比值**：
 *       纯线性 0.9/0.6 = 1.50
 *       混合式 0.90/0.487 = 1.85
 *   这才是"很渴压过有点渴"想要的效果，而且不打坏已有阈值。
 */
export const TENSION_EXP = 1.6;

export function tensionOf(state: MotivationState): Record<Need, number> {
  const out = {} as Record<Need, number>;
  for (const n of NEEDS) {
    const v = state.needs[n];
    out[n] = 0.55 * v + 0.45 * Math.pow(v, TENSION_EXP);
  }
  return out;
}

/** 单个需求的张力（tensionOf 的标量版，动机打分用） */
export function tension(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  return 0.55 * v + 0.45 * Math.pow(v, TENSION_EXP);
}

export function dominantNeed(state: MotivationState): Need {
  let best: Need = "connection";
  let bestV = -1;
  for (const n of NEEDS) {
    if (state.needs[n] > bestV) {
      bestV = state.needs[n];
      best = n;
    }
  }
  return best;
}

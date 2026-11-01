/**
 * 表达层：全系统唯一调用强模型的地方，而且它只做一件事——把既定动机说成人话。
 *
 * ── v3 的两处变化 ────────────────────────────────────────
 *   1. **确定性校验 + 一次重说**（express/verify.ts）。句数/禁语/复述真的会被查，
 *      不合格就带着违规清单重说一次。这是把"硬约束"从文本变成代码。
 *   2. **表情滞后**。内在情绪和说出口的情绪不是同一个数：表情改得慢。
 *
 * ── 两段式回忆（v2 起）──────────────────────────────────
 *   第一次调用只给卡片骨架（时间是哪天、状态、一句话、关键词）。
 *   如果模型觉得"光凭这个说不准"，它可以在 want_detail 里点名卡片 id，
 *   我们会去翻那几张卡片的原始记录，再问它一次。
 *
 *   为什么要让它自己决定：绝大多数轮次不需要原话，硬塞进去既费 token
 *   又会让它把细节复述一遍（那是客服腔的来源）。而一旦它主动要了，
 *   说明它确实需要那几句话才能说准 —— 这时多一次调用是值得的。
 *
 *   护栏：
 *     · 只允许要召回列表里的卡片（不能凭空点名）
 *     · 最多 cfg.recall.maxExpandCards 张
 *     · 只展开一轮，不会递归
 *     · 第二次调用失败就退回第一次的台词
 *
 * ── 调用次数上限（成本护栏）──────────────────────────────
 *   最坏 3 次：首说 → 翻原话 → 因违规重说。
 *   mock 提供方不重试（它没有改进能力，重说只会得到同一句，白跑）。
 */
import type { Env } from "../env.ts";
import type {
  ExpressOutput,
  MotivationCard,
  PersonDossier,
  RetrievedCard,
  TraceSlice,
  UserRead,
} from "../shared/types.ts";
import { ExpressOutputSchema } from "../shared/types.ts";
import { chatJson } from "../llm/provider.ts";
import { getMetaJson, setMetaJson } from "../store/db.ts";
import { logPrompt } from "../store/repos.ts";
import type { OpenLoopRow, PersonRow, SelfSheetRow, TraceRow } from "../store/repos.ts";
import { assemble } from "./assemble.ts";
import type { AssembledPrompt } from "./assemble.ts";
import { expandCard } from "../memory/retrieve.ts";
import { auditSpeech, violationNote } from "./verify.ts";
import type { AuditResult } from "./verify.ts";

export interface ExpressInput {
  now: number;
  person: PersonRow;
  /** v4：人物档案。她在跟谁说话、知道什么、还不知道什么 */
  dossier?: PersonDossier | null;
  self: SelfSheetRow | undefined;
  card: MotivationCard;
  cards: RetrievedCard[];
  recent: TraceRow[];
  loops: OpenLoopRow[];
  /** 本轮用户原句；主动发言时为空串 */
  currentUtterance: string;
  /** 他这句话的规则解读（校验"复述"和语气用） */
  read: UserRead;
}

export interface ExpressResult {
  out: ExpressOutput;
  prompt: AssembledPrompt;
  raw: { text: string; tokensIn: number; tokensOut: number; latencyMs: number };
  /** 是否走了第二段（翻原始记录） */
  expanded: boolean;
  details: TraceSlice[];
  /** 两段加起来的总耗时 */
  totalLatencyMs: number;
  /** 最终那句话的确定性审计 */
  audit: AuditResult;
  /** 是否因为违规重说过 */
  retried: boolean;
  /** 重说之后是否真的把违规改少了 */
  fixed: boolean;
  /** 表情滞后之后的对外情绪（内在情绪在 out.emotion 里） */
  displayEmotion: { valence: number; arousal: number; label: string; intensity: number };
}

export async function express(env: Env, input: ExpressInput): Promise<ExpressResult> {
  const first = await call(env, input, undefined);

  // ── 第二段：翻原话 ──
  const allowed = new Set(input.cards.map((c) => c.id));
  let ids = [...new Set(first.out.want_detail)]
    .filter((id) => allowed.has(id))
    .slice(0, env.cfg.recall.maxExpandCards);

  let current = first;
  let expanded = false;
  let slices: TraceSlice[] = [];

  if (!first.out.says_nothing && ids.length > 0) {
    for (const id of ids) {
      const slice = expandCard(env, id, env.cfg.recall.expandLines);
      if (slice) slices.push(slice);
    }
    if (slices.length > 0) {
      try {
        current = await call(env, input, slices);
        expanded = true;
      } catch (e) {
        console.warn("[express] 展开原话后重问失败，退回第一次的台词：", e instanceof Error ? e.message : e);
        current = first;
        slices = [];
      }
    }
  }

  // ── 第三段（可选）：确定性校验 + 一次重说 ──
  const auditOf = (o: ExpressOutput, details: TraceSlice[]): AuditResult =>
    auditSpeech({
      speech: o.speech,
      saysNothing: o.says_nothing,
      maxSentences: input.card.max_sentences,
      mustInclude: input.card.must_include,
      userText: input.currentUtterance,
      banned: env.persona.voice.banned_phrases,
    });

  let audit = auditOf(current.out, slices);
  let retried = false;
  let fixed = false;
  const canRetry = env.cfg.provider !== "mock" && !current.out.says_nothing && audit.violations.length > 0;

  if (canRetry) {
    retried = true;
    try {
      const retry = await call(env, input, slices.length > 0 ? slices : undefined, violationNote(audit.violations));
      const retryAudit = auditOf(retry.out, slices);
      if (retryAudit.violations.length < audit.violations.length) {
        fixed = true;
        current = retry;
        audit = retryAudit;
      } else {
        // 重说没变好：保留第一次的（至少它没为了合规把话删残）
      }
    } catch (e) {
      console.warn("[express] 违规重说失败，保留第一次的台词：", e instanceof Error ? e.message : e);
    }
  }

  const displayEmotion = lagEmotion(env, current.out.emotion, input.now);

  return {
    out: current.out,
    prompt: current.prompt,
    raw: current.raw,
    expanded,
    details: slices,
    totalLatencyMs: first.raw.latencyMs + (current === first ? 0 : current.raw.latencyMs),
    audit,
    retried,
    fixed,
    displayEmotion,
  };
}

async function call(
  env: Env,
  input: ExpressInput,
  details: TraceSlice[] | undefined,
  extraUser?: string,
): Promise<ExpressResult & { details: TraceSlice[] }> {
  const prompt = assemble(env, { ...input, details });
  const user = extraUser ? prompt.user + extraUser : prompt.user;

  const { value, raw } = await chatJson(
    env.llm,
    {
      kind: "express",
      system: prompt.system,
      user,
      temperature: 0.85,
      maxTokens: 900,
      json: { name: "speech", schema: { type: "object" } },
      hint: {
        // 之前这里取的是 recent 里最后一条 user —— 那是**上一轮**的话（recent 不含本轮）。
        // mock 不看内容所以没暴露，但日志里会误导排查。
        userText: input.currentUtterance,
        cardCount: input.cards.length,
      },
    },
    ExpressOutputSchema,
  );

  logPrompt(env.db, {
    ts: input.now,
    kind: details ? "express+detail" : extraUser ? "express+retry" : "express",
    model: env.cfg.expressModel,
    promptVersion: env.persona.hash,
    prompt: `${prompt.system}\n\n----\n\n${user}`,
    response: raw.text,
    tokensIn: raw.tokensIn,
    tokensOut: raw.tokensOut,
    costUsd: 0,
    latencyMs: raw.latencyMs,
    error: null,
  });

  return {
    out: value,
    prompt,
    raw,
    expanded: false,
    details: details ?? [],
    totalLatencyMs: raw.latencyMs,
    audit: { violations: [], metrics: { sentences: 0, chars: 0, repeatRatio: 0 }, bannedHits: [] },
    retried: false,
    fixed: false,
    displayEmotion: { valence: 0, arousal: 0.3, label: "平静", intensity: 0.5 },
  };
}

/**
 * 表情滞后：对外表情追不上内在情绪。
 *
 * 这是从"表现"里学来的一条：她说"没问题"的时候，脸上的哀伤还没散。
 * 实现上就是对外情绪做一次一阶平滑（alpha 越小越迟钝），
 * 状态存在 meta 里，重启后接着平滑。
 *
 * 注意：**不改 out.emotion**。那个值会流回 brain 的 nudgeAffect，
 * 是情绪动力学的输入；改它会污染状态机。滞后只影响"给人看的那个数"。
 */
const DISPLAY_ALPHA = 0.45;
const DISPLAY_KEY = "display_emotion";

function lagEmotion(
  env: Env,
  target: { valence: number; arousal: number; label: string; intensity: number },
  now: number,
): { valence: number; arousal: number; label: string; intensity: number } {
  const prev = getMetaJson<{ v: number; a: number; label: string; intensity: number }>(env.db, DISPLAY_KEY);
  const pv = prev?.v ?? 0;
  const pa = prev?.a ?? 0.3;
  const v = pv + (target.valence - pv) * DISPLAY_ALPHA;
  const a = pa + (target.arousal - pa) * DISPLAY_ALPHA;
  // 标签跟着目标走（标签是离散的，没法平均），强度跟着平滑后的值走
  const out = {
    valence: Number(v.toFixed(3)),
    arousal: Number(a.toFixed(3)),
    label: target.label,
    intensity: Number(
      Math.min(1, Math.abs(target.intensity - (prev?.intensity ?? 0.5)) * 0.5 + Math.abs(v) * 0.5).toFixed(3),
    ),
  };
  setMetaJson(env.db, DISPLAY_KEY, { v, a, label: out.label, intensity: out.intensity, at: now });
  return out;
}

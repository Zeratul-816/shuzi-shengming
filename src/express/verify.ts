/**
 * 表达层的确定性校验 —— 把"提示词里写的硬约束"变成"代码能查的硬约束"。
 *
 * ── 为什么必须做这一层 ───────────────────────────────────
 *   README 一直说动机卡带 `must_not` 和 `max_sentences` 是"硬约束"。
 *   但在 v2 它们只是**文本**：进提示词，然后祈祷。禁语表（banned_phrases）
 *   甚至有现成的机器可读列表，也从来没人扫过一遍。
 *
 *   这一层只做**能被机器判定**的四件事：
 *     1. 句数是不是超了 max_sentences
 *     2. 有没有踩禁语（子串匹配）
 *     3. 有没有复述他刚说的话（bigram Dice）
 *     4. must_include 里的东西在不在
 *   语义类的禁忌（"不许承认自己在勉强"）仍然只能靠模型自觉 —— 别骗自己。
 *   但要区分：**能查的没查**和**查不了的没查**，是两种不同的失职。
 *
 * ── 为什么用 Dice 判复述 ─────────────────────────────────
 *   "不复述对方刚说的话"是这条人设最容易被违反的一条，因为模型天然爱
 *   先确认再回答。用 bigram Dice ≥ 0.6 能抓住"你今天很累吧"（原句
 *   "我今天很累"）这类结构性复述，而不会误伤正常引述。
 *   标定见 store/bigram.ts 的注释（同义改写 ≈0.70，无关 ≈0.04）。
 *
 * ── 违规之后怎么办 ───────────────────────────────────────
 *   重试一次，把违规清单回灌给它（和 chatJson 的校验重试同一种做法）。
 *   仍不合格就**接受**并记账 —— 宁可说人话但超一句，也不要为了合规
 *   把话删成残句。所有结果都写 express_audit，那是"约束遵守率"的数据源。
 */
import type { SpeechMetrics, SpeechViolation } from "../shared/types.ts";
import { bigramDice } from "../store/bigram.ts";

export interface AuditInput {
  speech: string;
  saysNothing: boolean;
  maxSentences: number;
  mustInclude: string[];
  /** 他这一轮说的原句（主动发言时为空） */
  userText: string;
  /** persona/voice.json 的硬禁用 */
  banned: string[];
}

export interface AuditResult {
  violations: SpeechViolation[];
  metrics: SpeechMetrics;
  bannedHits: string[];
}

/** 硬上限：再长就不是"一到三句"了，而且 TTS/阅读体验都崩 */
const HARD_CHAR_LIMIT = 240;
/** 复述判定的门槛。0.6 不会误伤正常引述，能抓住结构性复述。 */
const REPEAT_THRESHOLD = 0.6;

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/**
 * 数句子。
 * 中文的句末标点：。！？；… 以及换行。
 * 「……」是停顿不是句末 —— 但连用两次（真的说完了）要算一句结束。
 */
export function countSentences(text: string): number {
  const t = text.replace(/\r/g, "").trim();
  if (!t) return 0;
  // 只按真正的句末标点和换行切。「……」是停顿，不是句末 ——
  // 把她的一句「嗯……今天有点冷」记成两句，会让句数上限形同虚设。
  const parts = t
    .split(/[。！？；!?;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && CJK.test(s));
  return parts.length === 0 ? 1 : parts.length;
}

export function auditSpeech(inp: AuditInput): AuditResult {
  const speech = inp.speech ?? "";
  const chars = [...speech].length;
  const sentences = inp.saysNothing ? 0 : countSentences(speech);
  const repeatRatio = inp.userText && speech ? bigramDice(speech, inp.userText) : 0;

  const violations: SpeechViolation[] = [];
  const bannedHits = inp.banned.filter((b) => b && speech.includes(b));

  if (!inp.saysNothing && speech.trim() === "") {
    violations.push({ code: "empty_speech", detail: "没说不说话，但也没说任何东西" });
  }
  if (!inp.saysNothing && sentences > inp.maxSentences) {
    violations.push({
      code: "too_many_sentences",
      detail: `说了 ${sentences} 句，动机只允许 ${inp.maxSentences} 句`,
    });
  }
  if (bannedHits.length > 0) {
    violations.push({ code: "banned_phrase", detail: `踩了禁语：${bannedHits.join(" / ")}` });
  }
  if (repeatRatio >= REPEAT_THRESHOLD) {
    violations.push({
      code: "repeats_user",
      detail: `和他刚说的重合度 ${repeatRatio.toFixed(2)}（≥${REPEAT_THRESHOLD} 视为复述）`,
    });
  }
  if (!inp.saysNothing) {
    const missing = inp.mustInclude.filter((m) => m && !speech.includes(m));
    if (missing.length > 0) {
      violations.push({ code: "must_include_missing", detail: `动机要求带上：${missing.join(" / ")}` });
    }
  }
  if (chars > HARD_CHAR_LIMIT) {
    violations.push({ code: "too_long", detail: `${chars} 字，超过硬上限 ${HARD_CHAR_LIMIT}` });
  }

  return { violations, metrics: { sentences, chars, repeatRatio }, bannedHits };
}

/**
 * 把违规清单变成一段回灌给模型的说明。
 * 措辞上刻意不解释"为什么"——解释会让模型开始跟你讨论规则，
 * 而这里只需要它改一句话。
 */
export function violationNote(v: SpeechViolation[]): string {
  const lines = v.map((x) => `- ${x.detail}`).join("\n");
  return (
    `\n\n[系统] 你上一句话有 ${v.length} 处不合格：\n${lines}\n` +
    `请重说一次。保持同样的意思和语气，只是改掉上面这几处。只输出 JSON。`
  );
}

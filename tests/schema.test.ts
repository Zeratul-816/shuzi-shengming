import { test } from "node:test";
import assert from "node:assert/strict";
import { ExpressOutputSchema, AppraisalSchema, CardDraftSchema } from "../src/shared/types.ts";

/**
 * 输出 schema 的容错边界。
 *
 * ── 这条测试的由来 ────────────────────────────────────────
 *   真机上模型把 `silence_kind` 填成了 `""`，zod 枚举拒绝，
 *   chatJson 重试一次仍然填 `""`，于是**整轮对话抛错消失**：
 *   用户这句话进了流水，却没有回复、没有留下卡片。
 *
 *   一类"外形字段"填歪不该杀掉一整轮。判据很简单：
 *   这个字段填错了，会不会影响"她说了什么"？
 *   不会 → 兜住；会 → 保持严格。
 */
test("表达输出：外形字段填歪了会被兜住，不至于让整轮消失", () => {
  const parsed = ExpressOutputSchema.parse({
    speech: "嗯。",
    says_nothing: false,
    silence_kind: "", // ← 真机上真的出现过
    gaze: "旁边", // 非枚举值
    pause_before_ms: 999999, // 越界
    emotion: { valence: 9, arousal: -1, label: "x".repeat(40), intensity: "高" },
    note_to_self: "y".repeat(300),
    want_detail: ["3"], // 类型错
  });

  assert.equal(parsed.silence_kind, "not_now");
  assert.equal(parsed.gaze, "user");
  assert.equal(parsed.pause_before_ms, 200);
  assert.equal(parsed.emotion.label, "平静");
  assert.equal(parsed.emotion.valence, 0);
  assert.equal(parsed.note_to_self, "");
  assert.deepEqual(parsed.want_detail, []);
  // 真正重要的字段不能被兜住
  assert.equal(parsed.speech, "嗯。");
});

test("表达输出：缺字段也能过（模型偶尔整个不写）", () => {
  const parsed = ExpressOutputSchema.parse({});
  assert.equal(parsed.speech, "");
  assert.equal(parsed.says_nothing, false);
  assert.equal(parsed.silence_kind, "not_now");
});

test("编码器输出：卡片的关键字段保持严格（错了就该重试，不能猜）", () => {
  // title 太短 → 必须报错，而不是兜成一个空标题
  assert.throws(() => CardDraftSchema.parse({ title: "嗯", detail: "细节细节" }));
  // 整个 appraisal 缺 felt / scores → 必须报错
  assert.throws(() => AppraisalSchema.parse({ cards: [] }));
});

test("编码器输出：可选字段缺失时走默认，不炸", () => {
  const ap = AppraisalSchema.parse({
    felt: { valence: 0, arousal: 0.3 },
    scores: { self_relevance: 0.5, novelty: 0.5, user_signal: 0.5, goal_relevance: 0.5 },
  });
  assert.deepEqual(ap.cards, []);
  assert.deepEqual(ap.people, []);
  assert.equal(ap.speaker.label, "");
  assert.equal(ap.speaker.introduced, false);
});

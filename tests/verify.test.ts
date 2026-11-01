import { test } from "node:test";
import assert from "node:assert/strict";
import { countSentences, auditSpeech, violationNote } from "../src/express/verify.ts";

test("数句子：中文句末标点、省略号、换行", () => {
  assert.equal(countSentences("嗯。"), 1);
  assert.equal(countSentences("嗯。我知道了。"), 2);
  assert.equal(countSentences("嗯……今天有点冷。"), 1, "省略号是停顿，不是句末");
  assert.equal(countSentences("嗯……今天有点冷……"), 1);
  assert.equal(countSentences("不要。"), 1);
  assert.equal(countSentences("第一句\n第二句"), 2);
  assert.equal(countSentences(""), 0);
  assert.equal(countSentences("   "), 0);
  assert.equal(countSentences("嗯？"), 1);
});

test("句数超限会被抓到", () => {
  const r = auditSpeech({
    speech: "嗯。我知道了。你先去忙。这件事我记下了。",
    saysNothing: false,
    maxSentences: 2,
    mustInclude: [],
    userText: "我先去忙了",
    banned: [],
  });
  assert.ok(r.violations.some((v) => v.code === "too_many_sentences"), JSON.stringify(r.violations));
  assert.equal(r.metrics.sentences, 4);
});

test("禁语表是真的会被扫的（不再是只写在提示词里）", () => {
  const r = auditSpeech({
    speech: "我理解你的感受。",
    saysNothing: false,
    maxSentences: 3,
    mustInclude: [],
    userText: "我今天很难受",
    banned: ["我理解你的感受", "希望这些对你有帮助"],
  });
  assert.ok(r.violations.some((v) => v.code === "banned_phrase"));
  assert.deepEqual(r.bannedHits, ["我理解你的感受"]);
});

test("复述判定：结构性复述被抓到，正常接话不误伤", () => {
  const repeat = auditSpeech({
    speech: "你说你今天特别累。",
    saysNothing: false,
    maxSentences: 3,
    mustInclude: [],
    userText: "我今天特别累",
    banned: [],
  });
  assert.ok(repeat.violations.some((v) => v.code === "repeats_user"), `ratio=${repeat.metrics.repeatRatio}`);

  const normal = auditSpeech({
    speech: "那我少说两句。",
    saysNothing: false,
    maxSentences: 3,
    mustInclude: [],
    userText: "我今天特别累",
    banned: [],
  });
  assert.ok(!normal.violations.some((v) => v.code === "repeats_user"), `ratio=${normal.metrics.repeatRatio}`);
});

test("must_include 缺失会被抓到（动机卡的硬要求）", () => {
  const r = auditSpeech({
    speech: "嗯，那件事我记着。",
    saysNothing: false,
    maxSentences: 3,
    mustInclude: ["茶"],
    userText: "",
    banned: [],
  });
  assert.ok(r.violations.some((v) => v.code === "must_include_missing"));
});

test("说不说话但 speech 空 = 违规；说了不说但给了 speech 不判违规", () => {
  const empty = auditSpeech({
    speech: "",
    saysNothing: false,
    maxSentences: 3,
    mustInclude: [],
    userText: "在吗",
    banned: [],
  });
  assert.ok(empty.violations.some((v) => v.code === "empty_speech"));

  const silent = auditSpeech({
    speech: "",
    saysNothing: true,
    maxSentences: 3,
    mustInclude: ["茶"],
    userText: "在吗",
    banned: ["我理解你的感受"],
  });
  assert.equal(silent.violations.length, 0, "沉默不该被判违规（沉默是一等公民）");
});

test("过硬上限也算违规（防止模型越写越长）", () => {
  const r = auditSpeech({
    speech: "嗯。".repeat(200),
    saysNothing: false,
    maxSentences: 6,
    mustInclude: [],
    userText: "",
    banned: [],
  });
  assert.ok(r.violations.some((v) => v.code === "too_long"));
});

test("违规说明会逐条列出，且不解释规则", () => {
  const note = violationNote([
    { code: "too_many_sentences", detail: "说了 4 句，动机只允许 2 句" },
    { code: "banned_phrase", detail: "踩了禁语：我理解你的感受" },
  ]);
  assert.ok(note.includes("说了 4 句"));
  assert.ok(note.includes("我理解你的感受"));
  assert.ok(note.includes("只输出 JSON"));
});

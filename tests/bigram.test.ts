import { test } from "node:test";
import assert from "node:assert/strict";
import { toBigram, toFtsQuery } from "../src/store/bigram.ts";

test("toBigram: 汉字出二元组，ASCII 出整词", () => {
  const t = toBigram("上线前");
  assert.ok(t.includes("上线"));
  assert.ok(t.includes("线前"));
  assert.equal(toBigram("GPT-4 好用").split(" ")[0], "gpt");
});

test("toBigram: 单字兜底，但剔除高频虚字", () => {
  const tokens = toBigram("猫跑丢了").split(" ");
  assert.ok(tokens.includes("猫"), "单字应进索引");
  assert.ok(tokens.includes("跑"));

  const stop = toBigram("我的了").split(" ");
  assert.ok(!stop.includes("的"), "虚字不该进索引");
  assert.ok(!stop.includes("我"));

  assert.equal(toBigram("疼"), "疼");
});

test("toBigram: 标点与空白不产生 token", () => {
  assert.equal(toBigram("，。！ "), "");
});

test("toFtsQuery: OR 连接（AND 会把同义改写全掐死）", () => {
  const q = toFtsQuery("上线前");
  assert.ok(q.includes('"上线"'));
  assert.ok(q.includes(" OR "));
  assert.ok(!q.includes(" AND "));
  assert.equal(toFtsQuery(""), "");
});

test("toFtsQuery: 去重，避免同一个词元把 bm25 刷歪", () => {
  const parts = toFtsQuery("上线上线").split(" OR ");
  assert.equal(parts.length, new Set(parts).size);
});

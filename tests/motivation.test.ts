import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/store/db.ts";
import { defaultState, drift, satisfy, tensionOf } from "../src/motivation/state.ts";
import { tick } from "../src/motivation/tick.ts";
import { readUserTurn } from "../src/motivation/reader.ts";
import type { MotivationState } from "../src/shared/types.ts";

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-mot-"));
  return { dir, db: openDb(path.join(dir, "t.db")) };
}

test("需求随时间漂移，情绪回归基线", () => {
  const now = Date.now();
  const s = defaultState(now - 2 * 3600_000);
  const before = s.needs.connection;
  drift(s, now);
  assert.ok(s.needs.connection > before, "两小时后联结需求应该涨了");
  assert.ok(s.needs.connection <= 1);
});

test("满足会回吐需求", () => {
  const s = defaultState(Date.now());
  s.needs.connection = 0.8;
  satisfy(s, "connection", 2);
  assert.ok(s.needs.connection < 0.5);
});

test("张力放大比值：高需求更占优势（v3：混合式，保留量级）", () => {
  const s = defaultState(Date.now());
  s.needs.connection = 0.9;
  s.needs.curiosity = 0.3;
  const t = tensionOf(s);
  // 比值被放大：纯线性是 3.0，混合式应明显大于 3
  assert.ok(t.connection / t.curiosity > 3, `实际比值 ${(t.connection / t.curiosity).toFixed(2)}`);
  // 但量级不能被压低（否则所有意图一起开不了口）
  assert.ok(t.connection > 0.85, `0.9 需求的张力应接近 0.9，实际 ${t.connection.toFixed(3)}`);
});

test("被动回应：他在说话时一定有卡，默认接法是 reply，且不需要迟滞", () => {
  const { dir, db } = tmpDb();
  const now = Date.now();
  const out = tick(db, defaultState(now), {
    now,
    userIdleMs: 0,
    starvedForNovelty: false,
    openLoops: [],
    pendingReply: true,
    read: readUserTurn(""),
  });
  assert.ok(out.card);
  assert.equal(out.card!.intent, "reply");
  // 字段名必须和 shared/types 的契约一致：v2 改名时这里曾残留 seed_atom_ids，
  // 导致"动机卡把相关卡片种进召回"这条通路静默失效
  assert.ok(Array.isArray(out.card!.seed_card_ids), "动机卡必须带 seed_card_ids");
  assert.equal(out.proactive, false);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("被动回应不再是单一意图：被关心时会拒绝被关心", () => {
  const { dir, db } = tmpDb();
  const now = Date.now();
  const s = defaultState(now);
  s.needs.competence = 0.8; // 她要证明自己行
  s.needs.connection = 0.3;

  const out = tick(db, s, {
    now,
    userIdleMs: 0,
    starvedForNovelty: false,
    openLoops: [],
    pendingReply: true,
    read: readUserTurn("你今天是不是很累，别勉强自己"),
  });
  assert.equal(out.card!.intent, "refuse_care");
  assert.ok(out.card!.max_sentences <= 2, "拒绝被关心要短");
  assert.ok(out.card!.must_not.some((m) => m.includes("承认自己在勉强")));

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("被动回应：问感受时走 deflect，而不是正面回答", () => {
  const { dir, db } = tmpDb();
  const now = Date.now();
  const s = defaultState(now);
  s.needs.expression = 0.3;

  const out = tick(db, s, {
    now,
    userIdleMs: 0,
    starvedForNovelty: false,
    openLoops: [],
    pendingReply: true,
    read: readUserTurn("你自己开心吗"),
  });
  assert.equal(out.card!.intent, "deflect");
  assert.ok(out.card!.must_not.some((m) => m.includes("正面回答")));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("被动回应：被夸时 test_self（把注意力挪到事情上）", () => {
  const { dir, db } = tmpDb();
  const now = Date.now();
  const s = defaultState(now);
  s.needs.competence = 0.6;
  const out = tick(db, s, {
    now,
    userIdleMs: 0,
    starvedForNovelty: false,
    openLoops: [],
    pendingReply: true,
    read: readUserTurn("刚才那个处理得真好，你真厉害"),
  });
  assert.equal(out.card!.intent, "test_self");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("主动发言：第一拍必须被迟滞压住，第二拍才允许开口", () => {
  const { dir, db } = tmpDb();
  const now = Date.now();
  const s: MotivationState = defaultState(now);
  s.needs.connection = 0.7; // 够渴但不到"紧急例外"的 0.85
  s.needs.rest = 0.1;
  s.needs.expression = 0.1;
  s.needs.curiosity = 0.1;
  s.needs.competence = 0.1;
  s.needs.autonomy = 0.1;
  s.lastProactiveAt = 0;
  s.updatedAt = now;

  const base = { starvedForNovelty: false, openLoops: [], pendingReply: false, read: readUserTurn("") };
  const t1 = tick(db, s, { ...base, now: now + 30_000, userIdleMs: 60 * 60_000 });
  assert.equal(t1.card, null, "第一拍应被迟滞压住");
  assert.ok(t1.rejected.some((r) => r.reason.includes("迟滞")), `实际：${JSON.stringify(t1.rejected)}`);

  const t2 = tick(db, t1.state, { ...base, now: now + 60_000, userIdleMs: 61 * 60_000 });
  assert.ok(t2.card, "第二拍应该开口");
  assert.equal(t2.card!.intent, "reach_out");
  assert.equal(t2.proactive, true);

  // 冷却期内不再重复
  const t3 = tick(db, t2.state, { ...base, now: now + 90_000, userIdleMs: 62 * 60_000 });
  assert.equal(t3.card, null, "冷却/全局间隔内应沉默");

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("没有需求被触发时，沉默是合法结果", () => {
  const { dir, db } = tmpDb();
  const now = Date.now();
  const s = defaultState(now);
  for (const k of Object.keys(s.needs) as (keyof typeof s.needs)[]) s.needs[k] = 0.05;
  const out = tick(db, s, {
    now,
    userIdleMs: 60_000,
    starvedForNovelty: false,
    openLoops: [],
    pendingReply: false,
    read: readUserTurn(""),
  });
  assert.equal(out.card, null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("v3 回归：被压制的原因必须分档，不能一律写「冷却中」", () => {
  const { dir, db } = tmpDb();
  const now = Date.now();
  // 需求全低 → 所有主动意图的前置条件都不满足
  const s = defaultState(now);
  for (const k of Object.keys(s.needs) as (keyof typeof s.needs)[]) s.needs[k] = 0.05;
  const out = tick(db, s, {
    now,
    userIdleMs: 60_000,
    starvedForNovelty: false,
    openLoops: [],
    pendingReply: false,
    read: readUserTurn(""),
  });
  const reasons = out.rejected.map((r) => r.reason);
  assert.ok(reasons.length > 0, "应该有被压制的候选");
  assert.ok(
    reasons.every((r) => !r.includes("冷却中")),
    `前置条件不满足不该被记成冷却中，实际：${reasons.join(" / ")}`,
  );
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readUserTurn：粗分类的边界", () => {
  assert.equal(readUserTurn("你今天累不累，别勉强自己").caring, true);
  // 真机上真实出现过的说法（第一版一个都没命中）
  assert.equal(readUserTurn("你还撑得住吗？听起来挺累的").caring, true);
  assert.equal(readUserTurn("辛苦你了").caring, true);
  assert.equal(readUserTurn("要不要歇一会").caring, true);
  // ★ 别把"我在累"当成"他在关心她"
  assert.equal(readUserTurn("我今天特别累").caring, false);
  assert.equal(readUserTurn("我快撑不住了").caring, false);

  assert.equal(readUserTurn("你自己开心吗").askingFeeling, true);
  assert.equal(readUserTurn("你觉得这个方案怎么办").askingOpinion, true);
  // 问观点不该被当成问感受（否则每次问意见她都在回避）
  assert.equal(readUserTurn("你觉得这个方案怎么办").askingFeeling, false);
  assert.equal(readUserTurn("你真厉害").praising, true);
  assert.equal(readUserTurn("快去把那个弄好").demanding, true);
  assert.equal(readUserTurn("今天服务器又挂了").caring, false);
  assert.equal(readUserTurn("").empty, true);
});

test("回应型意图不会变成开关：连续两轮被关心时，第二轮会退回普通接法", () => {
  const { dir, db } = tmpDb();
  const now = Date.now();
  const s = defaultState(now);
  s.needs.competence = 0.4;
  const caring = readUserTurn("你还撑得住吗");

  const t1 = tick(db, s, {
    now,
    userIdleMs: 0,
    starvedForNovelty: false,
    openLoops: [],
    pendingReply: true,
    read: caring,
  });
  assert.equal(t1.card!.intent, "refuse_care", "第一次应当拒绝被关心");

  const t2 = tick(db, t1.state, {
    now: now + 60_000,
    userIdleMs: 0,
    starvedForNovelty: false,
    openLoops: [],
    pendingReply: true,
    read: caring,
  });
  assert.equal(t2.card!.intent, "reply", "连着第二轮还拒绝就太假了");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

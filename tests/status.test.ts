import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEnv } from "../src/env.ts";
import { insertCard, getCard, liveCards } from "../src/store/repos.ts";
import { all } from "../src/store/db.ts";
import { previewExpirations, refreshStatuses, PLAN_GRACE_MS } from "../src/memory/status.ts";

const DAY = 86_400_000;

function tmpEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-status-"));
  const env = createEnv({ dbPath: path.join(dir, "t.db"), dataDir: dir, provider: "mock" });
  return { dir, env };
}

function mk(
  env: ReturnType<typeof tmpEnv>["env"],
  over: { title: string; kind?: "event" | "fact" | "plan" | "joke"; eventAt: number; validTo?: number | null },
) {
  return insertCard(env.db, {
    kind: over.kind ?? "plan",
    status: "active",
    title: over.title,
    detail: "细节若干。",
    personId: null,
    eventAt: over.eventAt,
    eventHint: null,
    timePrecision: "day",
    validFrom: null,
    validTo: over.validTo ?? null,
    keywords: ["出差"],
    entities: [],
    salience: 0.6,
    valence: 0,
    arousal: 0.3,
    confidence: 1,
    threadId: null,
    episodeId: null,
    traceFrom: null,
    traceTo: null,
    notKnown: null,
  });
}

test("时间驱动过期：计划的时间过去之后自动失效（v2 完全缺失的那一环）", () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();

  const past = mk(env, { title: "他说下周三去上海出差", eventAt: now - 3 * DAY });
  const future = mk(env, { title: "他说明天要去修车", eventAt: now + DAY });
  const today = mk(env, { title: "他今天下午要去开会", eventAt: now });

  const rep = refreshStatuses(env, now);
  assert.equal(rep.expired, 1, `只该让过去的那张失效，实际 ${rep.expired}`);
  assert.equal(getCard(env.db, past)!.status, "expired");
  assert.equal(getCard(env.db, future)!.status, "active", "未来的计划不该被提前失效");
  assert.equal(getCard(env.db, today)!.status, "active", "当天的计划仍在宽限期内");

  // 迁移必须留痕（否则调 status 逻辑时无从下手）
  const logs = all<{ card_id: number; reason: string }>(env.db, "SELECT * FROM card_status_log");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].card_id, past);
  assert.ok(logs[0].reason.includes("计划的时间"));

  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("宽限期：刚过 event_at 不到 PLAN_GRACE 的计划还算成立", () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const id = mk(env, { title: "他今天上午要去体检", eventAt: now - PLAN_GRACE_MS / 2 });
  refreshStatuses(env, now);
  assert.equal(getCard(env.db, id)!.status, "active", "当天的事不能一过点就判失效");
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("valid_to 过期：任何带明确有效期的卡片都会失效", () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const id = mk(env, { title: "他这周在禁酒", kind: "fact", eventAt: now - 10 * DAY, validTo: now - DAY });
  const keep = mk(env, { title: "他住在城东", kind: "fact", eventAt: now - 10 * DAY, validTo: now + 10 * DAY });

  refreshStatuses(env, now);
  assert.equal(getCard(env.db, id)!.status, "expired");
  assert.equal(getCard(env.db, keep)!.status, "active");
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("不碰不该碰的：fact / joke / 已失效的不动", () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const fact = mk(env, { title: "他的名字是小林", kind: "fact", eventAt: now - 300 * DAY });
  const joke = mk(env, { title: "他说要把公司买了", kind: "joke", eventAt: now - 300 * DAY });

  const rep = refreshStatuses(env, now);
  assert.equal(rep.expired, 0, "稳定事实和玩笑不该因为时间流逝失效");
  assert.equal(getCard(env.db, fact)!.status, "active");
  assert.equal(getCard(env.db, joke)!.status, "active");
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("预览不写库（评测要能问'现在跑会发生什么'而不改变结果）", () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const id = mk(env, { title: "他说上周要去北京", eventAt: now - 5 * DAY });

  const preview = previewExpirations(env, now);
  assert.equal(preview.length, 1);
  assert.equal(getCard(env.db, id)!.status, "active", "预览不该改状态");

  refreshStatuses(env, now);
  assert.equal(getCard(env.db, id)!.status, "expired");
  assert.equal(previewExpirations(env, now).length, 0);
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Brain 启动即维护：过期发生在构造时，而不是等下一次提到它", () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const id = mk(env, { title: "他下周要出差三天", eventAt: now - 30 * DAY });
  assert.equal(getCard(env.db, id)!.status, "active");

  // 重新构造一个 Brain 等价于"下一次启动"
  return import("../src/brain.ts").then(async ({ Brain }) => {
    const b = new Brain(env);
    assert.equal(getCard(env.db, id)!.status, "expired", "启动时必须扫一遍");
    await b.settle();
    assert.ok(liveCards(env.db, 10).length >= 1, "失效的卡片仍然在库里，只是不 active");
    b.close();
    env.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEnv } from "../src/env.ts";
import { Brain } from "../src/brain.ts";
import { insertCard, recentByCreation, primaryPerson, liveCards } from "../src/store/repos.ts";

const DAY = 86_400_000;

function tmpEnv(over: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-ret3-"));
  const env = createEnv({ dbPath: path.join(dir, "t.db"), dataDir: dir, provider: "mock", ...over });
  primaryPerson(env.db, Date.now());
  return { dir, env };
}

function mk(
  env: ReturnType<typeof tmpEnv>["env"],
  o: {
    title: string;
    eventAt: number;
    createdAt?: number;
    keywords?: string[];
    confidence?: number;
    salience?: number;
    kind?: "event" | "plan";
  },
) {
  return insertCard(env.db, {
    kind: o.kind ?? "event",
    status: "active",
    title: o.title,
    detail: "细节若干，够长了。",
    personId: 1,
    eventAt: o.eventAt,
    eventHint: null,
    timePrecision: "day",
    validFrom: null,
    validTo: null,
    keywords: o.keywords ?? ["项目"],
    entities: [],
    salience: o.salience ?? 0.6,
    valence: 0,
    arousal: 0.3,
    confidence: o.confidence ?? 1,
    threadId: null,
    episodeId: null,
    traceFrom: null,
    traceTo: null,
    notKnown: null,
    createdAt: o.createdAt,
  });
}

test("v3 修语义：「最近」按我得知的时间（created_at），不按事件时间", () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  // 一张将来才发生的计划，但我昨天就知道了
  const future = mk(env, { title: "他下周三要去上海出差", eventAt: now + 5 * DAY, createdAt: now - DAY, kind: "plan" });
  // 一张很久以前发生的，但我刚听说
  const heard = mk(env, { title: "他小时候养过一只狗", eventAt: now - 3000 * DAY, createdAt: now - 3600_000 });

  const recent = recentByCreation(env.db, now - 3 * DAY, 20);
  const ids = recent.map((r) => r.id);
  assert.ok(ids.includes(future), "昨天得知的事，即便发生在将来，也算最近聊过");
  assert.ok(ids.includes(heard), "刚听说的事，即便发生在很久以前，也算最近聊过");

  // 用**很久以前得知**的将来的事，就不该算最近
  const stale = mk(env, { title: "他去年说要去西安出差", eventAt: now + 2 * DAY, createdAt: now - 200 * DAY, kind: "plan" });
  const recent2 = recentByCreation(env.db, now - 3 * DAY, 20).map((r) => r.id);
  assert.ok(!recent2.includes(stale), "三个月前得知的计划不该占着「最近」通道");
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("v3 修语义：未来的卡片不再拿满分时间契合，会被同期卡片压过", async () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const near = mk(env, { title: "项目今天就要交", eventAt: now - 3600_000 });
  const far = mk(env, { title: "项目五天后才要交", eventAt: now + 5 * DAY });

  const hits = await new Brain(env).recallProbe("项目", now);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, near, `当下的那件事该排前面（未来卡片要付距离代价），实际第一是 #${hits[0].id}（far=#${far}）`);
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("confidence 参与打分：不确定的记忆排在确定的后面", async () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const sure = mk(env, { title: "他确认要搬家了", eventAt: now - DAY, confidence: 1 });
  const guess = mk(env, { title: "他大概要搬家吧", eventAt: now - DAY, confidence: 0.3 });

  const hits = await new Brain(env).recallProbe("搬家", now);
  assert.ok(hits.length >= 2, `应召回两张，实际 ${hits.length}`);
  assert.equal(hits[0].id, sure);
  const guessHit = hits.find((h) => h.id === guess)!;
  assert.ok(hits[0].score > guessHit.score, "低 confidence 必须被降权");
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("反刍通道：低概率塞进一张跟话题无关但当时重要的旧卡", async () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  mk(env, { title: "项目要延期了", eventAt: now - DAY });
  const old = mk(env, {
    title: "他说他其实很怕一个人待着",
    eventAt: now - 40 * DAY,
    createdAt: now - 40 * DAY,
    keywords: ["孤独"],
    salience: 0.9,
  });

  const { recall } = await import("../src/memory/retrieve.ts");
  // 命中（rng 返回 0 < 0.12）+ 固定随机，保证可复现
  const hit = await recall(env, {
    now,
    turnId: -1,
    queryText: "项目",
    card: null,
    personId: 1,
    rng: () => 0,
    noSerendipity: false,
  });
  assert.equal(hit.channels.sudden, 1, `应触发反刍，实际 ${JSON.stringify(hit.channels)}`);
  assert.ok(hit.cards.some((c) => c.id === old && c.channel === "sudden"), "被反刍带进来的卡片通道应为 sudden");

  // 关掉就不该出现
  const off = await recall(env, {
    now,
    turnId: -1,
    queryText: "项目",
    card: null,
    personId: 1,
    rng: () => 0,
    noSerendipity: true,
    dryRun: true,
  });
  assert.ok(!off.channels.sudden);
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("探针是只读的：/mem 不写召回日志、不提升强度", async () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const id = mk(env, { title: "项目要延期了", eventAt: now - DAY });
  const before = liveCards(env.db, 10).find((c) => c.id === id)!.strength;

  const brain = new Brain(env);
  await brain.recallProbe("项目", now);

  const logs = env.db.prepare("SELECT COUNT(*) AS n FROM recall_log").get() as { n: number };
  assert.equal(logs.n, 0, "调试探针不该写召回日志");
  const after = liveCards(env.db, 10).find((c) => c.id === id)!.strength;
  assert.equal(after, before, "调试探针不该改动卡片的强度");

  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("情绪同频：心情差的时候更容易想起难过的记忆", async () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const sad = insertCard(env.db, {
    kind: "event",
    status: "active",
    title: "他说他撑不住了",
    detail: "他声音很低。",
    personId: 1,
    eventAt: now - 2 * DAY,
    eventHint: null,
    timePrecision: "day",
    validFrom: null,
    validTo: null,
    keywords: ["撑不住"],
    entities: [],
    salience: 0.6,
    valence: -0.9,
    arousal: 0.7,
    confidence: 1,
    threadId: null,
    episodeId: null,
    traceFrom: null,
    traceTo: null,
    notKnown: null,
  });
  const cheerful = insertCard(env.db, {
    kind: "event",
    status: "active",
    title: "他说今天很顺",
    detail: "他笑了一下。",
    personId: 1,
    eventAt: now - 2 * DAY,
    eventHint: null,
    timePrecision: "day",
    validFrom: null,
    validTo: null,
    keywords: ["很顺"],
    entities: [],
    salience: 0.6,
    valence: 0.9,
    arousal: 0.5,
    confidence: 1,
    threadId: null,
    episodeId: null,
    traceFrom: null,
    traceTo: null,
    notKnown: null,
  });

  const { recall } = await import("../src/memory/retrieve.ts");
  // 用一个不命中任何卡片标题的查询，把关键词通道清零 ——
  // 否则 bm25 名次差会压过 0.08 的情绪权重，测的就不是情绪同频了。
  const Q = "随便聊聊";
  const lowMood = await recall(env, {
    now,
    turnId: -1,
    queryText: Q,
    card: null,
    personId: 1,
    affect: { v: -0.8, a: 0.6 },
    noSerendipity: true,
    dryRun: true,
  });
  const sadScore = lowMood.cards.find((c) => c.id === sad)?.score ?? 0;
  const cheerScore = lowMood.cards.find((c) => c.id === cheerful)?.score ?? 0;
  assert.ok(sadScore > cheerScore, `心情差时应偏向难过的那张：sad=${sadScore} cheer=${cheerScore}`);

  const highMood = await recall(env, {
    now,
    turnId: -1,
    queryText: Q,
    card: null,
    personId: 1,
    affect: { v: 0.8, a: 0.5 },
    noSerendipity: true,
    dryRun: true,
  });
  const sad2 = highMood.cards.find((c) => c.id === sad)?.score ?? 0;
  const cheer2 = highMood.cards.find((c) => c.id === cheerful)?.score ?? 0;
  assert.ok(cheer2 > sad2, `心情好时应偏向顺利的那张：sad=${sad2} cheer=${cheer2}`);
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

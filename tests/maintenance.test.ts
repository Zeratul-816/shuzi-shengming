import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applySchema, openDb, all } from "../src/store/db.ts";
import { createEnv } from "../src/env.ts";
import { consolidate } from "../src/memory/consolidate.ts";
import { insertCard, primaryPerson, openEpisode } from "../src/store/repos.ts";

function tmpDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("加列迁移：旧库缺 thread.summarized_at 时自动补上，且幂等", () => {
  const dir = tmpDir("dh-mig-");
  const dbPath = path.join(dir, "t.db");
  const db = openDb(dbPath);

  // 模拟"旧库"：把这列删掉（SQLite 3.35+ 支持 DROP COLUMN）
  db.exec("ALTER TABLE thread DROP COLUMN summarized_at;");
  const before = all<{ name: string }>(db, "PRAGMA table_info(thread)").map((c) => c.name);
  assert.ok(!before.includes("summarized_at"), "前置条件：列应已被删除");

  applySchema(db); // 再跑一次建表流程
  const after = all<{ name: string }>(db, "PRAGMA table_info(thread)").map((c) => c.name);
  assert.ok(after.includes("summarized_at"), "applySchema 应把缺的列补回来");

  applySchema(db); // 幂等：不应抛错
  const again = all<{ name: string }>(db, "PRAGMA table_info(thread)").map((c) => c.name);
  assert.equal(again.filter((n) => n === "summarized_at").length, 1);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("按 episode 取最近卡片走索引，不再全表扫", () => {
  const dir = tmpDir("dh-idx-");
  const db = openDb(path.join(dir, "t.db"));

  const plan = all<{ detail: string }>(
    db,
    `EXPLAIN QUERY PLAN
     SELECT * FROM card
      WHERE episode_id = ? AND superseded_by IS NULL
      ORDER BY id DESC LIMIT 8`,
    [1],
  );
  const text = plan.map((p) => p.detail).join(" ");
  assert.ok(
    /idx_card_episode|USING (COVERING )?INDEX/i.test(text),
    `应命中索引，实际计划：${text}`,
  );

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("巩固会裁剪过期日志：召回 90 天、调用 30 天", async () => {
  const dir = tmpDir("dh-prune-");
  const env = createEnv({ dbPath: path.join(dir, "t.db"), dataDir: dir, provider: "mock" });
  const now = Date.now();
  const person = primaryPerson(env.db, now);
  const ep = openEpisode(env.db, now, "system", "t");

  const cardId = insertCard(env.db, {
    kind: "event",
    status: "active",
    title: "他说上线要延期",
    detail: "他讲的时候声音有点低。",
    personId: person.id,
    eventAt: now,
    eventHint: "刚才",
    timePrecision: "day",
    validFrom: null,
    validTo: null,
    keywords: ["上线"],
    entities: [],
    salience: 0.6,
    valence: 0,
    arousal: 0.3,
    confidence: 1,
    threadId: null,
    episodeId: ep,
    traceFrom: null,
    traceTo: null,
    notKnown: null,
  });

  const DAY = 86_400_000;
  // 一条该留、一条该删
  env.db
    .prepare("INSERT INTO recall_log(ts, turn_id, card_id, score, channel) VALUES (?,?,?,?,?)")
    .run(now - 10 * DAY, 1, cardId, 0.5, "fts");
  env.db
    .prepare("INSERT INTO recall_log(ts, turn_id, card_id, score, channel) VALUES (?,?,?,?,?)")
    .run(now - 200 * DAY, 2, cardId, 0.5, "fts");
  env.db
    .prepare("INSERT INTO prompt_log(ts, kind, model, prompt, response) VALUES (?,?,?,?,?)")
    .run(now - 5 * DAY, "express", "m", "p", "r");
  env.db
    .prepare("INSERT INTO prompt_log(ts, kind, model, prompt, response) VALUES (?,?,?,?,?)")
    .run(now - 40 * DAY, "express", "m", "p", "r");

  const rep = await consolidate(env, now);
  assert.equal(rep.prunedRecall, 1, `召回日志应删 1 行，实际 ${rep.prunedRecall}`);
  assert.equal(rep.prunedPrompt, 1, `调用日志应删 1 行，实际 ${rep.prunedPrompt}`);

  const recallLeft = all<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM recall_log")[0].n;
  const promptLeft = all<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM prompt_log")[0].n;
  assert.equal(recallLeft, 1, "10 天内的召回日志要保留");
  assert.equal(promptLeft, 1, "5 天内的调用日志要保留");

  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

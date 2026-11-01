import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/store/db.ts";
import {
  addTrace,
  applyDecay,
  getCard,
  insertCard,
  liveCards,
  openEpisode,
  searchFts,
  traceRange,
  type NewCard,
} from "../src/store/repos.ts";

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-store-"));
  return { dir, db: openDb(path.join(dir, "t.db")) };
}

function card(over: Partial<NewCard> = {}): NewCard {
  const now = Date.now();
  return {
    kind: "event",
    status: "active",
    title: "他说上线前一晚没睡，声音发干",
    detail: "他讲这件事的时候声音有点低，我听着有点心疼。",
    personId: null,
    eventAt: now,
    eventHint: "刚才",
    timePrecision: "day",
    validFrom: null,
    validTo: null,
    keywords: ["上线", "熬夜"],
    entities: ["公司"],
    salience: 0.6,
    valence: -0.1,
    arousal: 0.4,
    confidence: 1,
    threadId: null,
    episodeId: null,
    traceFrom: null,
    traceTo: null,
    notKnown: null,
    ...over,
  };
}

test("schema 可重复执行（幂等），版本号是 2", () => {
  const { dir, db } = tmpDb();
  db.exec(fs.readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8"));
  const v = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
  assert.equal(v.value, "2");
  const n = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get() as { n: number };
  assert.ok(n.n > 20);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("写入卡片后 2 字词也能全文命中（bigram 索引，含 keywords）", () => {
  const { dir, db } = tmpDb();
  const id = insertCard(db, card());

  for (const q of ["上线", "熬夜", "声音", "公司"]) {
    const hits = searchFts(db, q, 5);
    assert.equal(hits.length, 1, `查询「${q}」应命中 1 张，实际 ${hits.length}`);
    assert.equal(hits[0].id, id);
  }
  assert.equal(searchFts(db, "火锅", 5).length, 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("衰减：重要卡片有下限；joke 比 event 掉得快", () => {
  const { dir, db } = tmpDb();
  const now = Date.now();
  const old = now - 30 * 86_400_000;

  const important = insertCard(db, card({ eventAt: old, createdAt: old, salience: 0.9 }));
  const joke = insertCard(db, card({ kind: "joke", eventAt: old, createdAt: old, title: "他说要辞职去开面馆", salience: 0.5 }));
  const event = insertCard(db, card({ kind: "event", eventAt: old, createdAt: old, title: "他问天气怎么样", salience: 0.5 }));

  applyDecay(db, now);
  const a = getCard(db, important)!;
  const j = getCard(db, joke)!;
  const e = getCard(db, event)!;

  assert.ok(a.strength >= 0.15 * a.salience - 1e-6, `重要卡片不该低于 floor，实际 ${a.strength}`);
  assert.ok(j.strength < e.strength, `玩笑应比事件掉得快：joke=${j.strength} event=${e.strength}`);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("已失效的卡片衰减更快（半衰期减半）", () => {
  const { dir, db } = tmpDb();
  const now = Date.now();
  const old = now - 10 * 86_400_000;
  const active = insertCard(db, card({ eventAt: old, createdAt: old, salience: 0.5 }));
  const expired = insertCard(
    db,
    card({ eventAt: old, createdAt: old, salience: 0.5, status: "expired", title: "他当时说下周要搬家" }),
  );

  applyDecay(db, now);
  assert.ok(getCard(db, expired)!.strength < getCard(db, active)!.strength);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("self 类卡片不衰减", () => {
  const { dir, db } = tmpDb();
  const id = insertCard(
    db,
    card({
      kind: "self",
      eventAt: Date.now() - 400 * 86_400_000,
      createdAt: Date.now() - 400 * 86_400_000,
      title: "我是一个会忘事的东西",
      salience: 0.8,
    }),
  );
  applyDecay(db, Date.now());
  assert.equal(getCard(db, id)!.strength, 0.8);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("翻原始记录：按卡片存的 trace 区间取回原话", () => {
  const { dir, db } = tmpDb();
  const ep = openEpisode(db, Date.now(), "system", "t");
  const now = Date.now();
  const t1 = addTrace(db, { episodeId: ep, ts: now, role: "user", content: "昨天熬到三点改上线" });
  addTrace(db, { episodeId: ep, ts: now + 1, role: "me", content: "嗯，我在。" });
  const t3 = addTrace(db, { episodeId: ep, ts: now + 2, role: "user", content: "今天还得早起" });

  insertCard(db, card({ episodeId: ep, traceFrom: t1, traceTo: t3 }));
  const slice = traceRange(db, t1, t3, 8);
  assert.equal(slice.length, 3);
  assert.equal(slice[0].content, "昨天熬到三点改上线");

  assert.equal(liveCards(db, 10).length, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

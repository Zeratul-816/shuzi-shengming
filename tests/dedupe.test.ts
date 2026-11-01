import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEnv } from "../src/env.ts";
import { writeCards } from "../src/memory/cards.ts";
import { consolidate, applyMergeGroups } from "../src/memory/consolidate.ts";
import { openEpisode, liveCards, primaryPerson, insertCard } from "../src/store/repos.ts";
import { AppraisalSchema } from "../src/shared/types.ts";
import { bigramDice } from "../src/store/bigram.ts";

function tmpEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-dedupe-"));
  const env = createEnv({ dbPath: path.join(dir, "t.db"), dataDir: dir, provider: "mock" });
  primaryPerson(env.db, Date.now());
  return { dir, env };
}

function withCard(title: string, detail: string, kind: "event" | "fact" | "relation" | "self" = "event") {
  return AppraisalSchema.parse({
    felt: { valence: -0.1, arousal: 0.4, labels: ["平静"] },
    scores: { self_relevance: 0.6, novelty: 0.4, user_signal: 0.5, goal_relevance: 0.3 },
    cards: [{ title, detail, kind, status: "active", keywords: [], entities: [] }],
  });
}

async function write(
  env: ReturnType<typeof tmpEnv>["env"],
  episodeId: number,
  title: string,
  detail: string,
  kind?: "event" | "fact" | "relation" | "self",
) {
  return writeCards(env, withCard(title, detail, kind), {
    now: Date.now() + Math.floor(Math.random() * 1000),
    episodeId,
    personId: 1,
    traceFrom: null,
    traceTo: null,
  });
}

test("bigramDice 的标定：同义改写高、无关低", () => {
  const dup = bigramDice(
    "他先拦住我，说别急着安慰，像是怕被轻轻带过去",
    "他拦住我别急着安慰，像是怕被一句软话轻轻带过去。",
  );
  const diff = bigramDice("他下班路上一直在想自己是不是真的做得不好", "我问的是被说时具体哪句话，他还没答");
  const none = bigramDice("他夸我那句答得好", "今天服务器又挂了两次");

  assert.ok(dup > 0.6, `同义改写应 > 0.6，实际 ${dup.toFixed(3)}`);
  assert.equal(none, 0);
  assert.ok(dup - diff > 0.3, "同义改写与不同事之间要有足够间隔");
});

test("同一张卡片写两次 → 只留一张（复述强化）", async () => {
  const { dir, env } = tmpEnv();
  const ep = openEpisode(env.db, Date.now(), "system", "t");
  const title = "他说上线前一晚没睡，声音发干";
  const detail = "他讲的时候声音有点低，我听着有点心疼。";

  const r1 = await write(env, ep, title, detail);
  const r2 = await write(env, ep, title, detail);

  assert.equal(r1.inserted, 1);
  assert.equal(r2.inserted, 0, "第二次不该新增");
  assert.equal(r2.merged, 1, "第二次应走合并");
  assert.equal(liveCards(env.db, 20).length, 1);

  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("同义改写 → 判为同一张", async () => {
  const { dir, env } = tmpEnv();
  const ep = openEpisode(env.db, Date.now(), "system", "t");

  await write(env, ep, "他拦着我别急着安慰", "像是怕被一句软话轻轻带过去。", "relation");
  const r2 = await write(env, ep, "他先拦住我说别急着安慰", "像是怕被一句话轻轻带过去。", "relation");

  assert.equal(r2.inserted, 0, "改写不该新建");
  assert.equal(liveCards(env.db, 20).length, 1);
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("不同的事不会被误合并", async () => {
  const { dir, env } = tmpEnv();
  const ep = openEpisode(env.db, Date.now(), "system", "t");

  await write(env, ep, "他在想自己是不是真的做得不好", "下班路上一路没说话。");
  await write(env, ep, "他问我被说时有没有别人在场", "我没答上来。");

  assert.equal(liveCards(env.db, 20).length, 2);
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("applyMergeGroups：保留最结实的一张，其余软删除；非法分组不炸", async () => {
  const { dir, env } = tmpEnv();
  const ep = openEpisode(env.db, Date.now(), "system", "t");

  const w1 = await write(env, ep, "我问他被说时有没有别人在场", "他没答，我也没敢追。");
  const w2 = await write(env, ep, "我问的是被说的时候旁边有没有人", "他还没答，我心里悬着。");
  const w3 = await write(env, ep, "他今天在公司被说了一顿", "回来路上一直在想。");
  assert.equal(liveCards(env.db, 20).length, 3);

  const ids = [w1.ids[0], w2.ids[0], w3.ids[0]];
  assert.equal(applyMergeGroups(env, ids, [[0, 1]]), 1);
  assert.equal(liveCards(env.db, 20).length, 2);

  assert.equal(applyMergeGroups(env, ids, [[0, 99], [], [1]]), 0);
  assert.equal(liveCards(env.db, 20).length, 2);

  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("巩固：合掉历史遗留的字面重复，并把同主题卡片串成线", async () => {
  const { dir, env } = tmpEnv();
  const ep = openEpisode(env.db, Date.now(), "system", "t");
  const now = Date.now();

  const mk = (title: string, detail: string, daysAgo: number) =>
    insertCard(env.db, {
      kind: "event",
      status: "active",
      title,
      detail,
      personId: 1,
      eventAt: now - daysAgo * 86_400_000,
      eventHint: null,
      timePrecision: "day",
      validFrom: null,
      validTo: null,
      keywords: ["上线", "报错"],
      entities: [],
      salience: 0.5,
      valence: 0,
      arousal: 0.3,
      confidence: 1,
      threadId: null,
      episodeId: ep,
      traceFrom: null,
      traceTo: null,
      notKnown: null,
    });

  mk("上线一直在报错，我修到凌晨三点", "他声音都哑了。", 3);
  mk("上线一直在报错，我修到凌晨三点。", "他声音都哑了。", 2);
  mk("上线又挂了，这次是数据库", "他说这次不怪我。", 1);

  const rep = await consolidate(env, now);
  assert.ok(rep.merged >= 1, `应合掉字面重复，实际 ${rep.merged}`);
  assert.equal(liveCards(env.db, 20).length, 2);
  assert.ok(rep.threadsFormed + rep.threadsSummarized >= 1, "同主题卡片应被串成线");

  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

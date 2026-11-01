import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEnv } from "../src/env.ts";
import { writeCards } from "../src/memory/cards.ts";
import { renderCards } from "../src/express/assemble.ts";
import { formThreads } from "../src/memory/consolidate.ts";
import {
  getCard,
  insertCard,
  linksOfCard,
  logExpressAudit,
  openEpisode,
  primaryPerson,
  auditStats,
} from "../src/store/repos.ts";
import { all } from "../src/store/db.ts";
import { toRetrievedCard } from "../src/store/repos.ts";
import { AppraisalSchema, type RetrievedCard } from "../src/shared/types.ts";

function tmpEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-closure-"));
  const env = createEnv({ dbPath: path.join(dir, "t.db"), dataDir: dir, provider: "mock" });
  primaryPerson(env.db, Date.now());
  return { dir, env };
}

function appraisal(over: Record<string, unknown> = {}) {
  return AppraisalSchema.parse({
    attention: "我一直在听他说到'没睡'两个字的时候",
    meant_to_me: "他累成这样还在跟我解释，我不太舒服",
    not_known: "他说'还是我自己来吧'，我不知道他是嫌我慢还是不想麻烦我",
    felt: { valence: -0.2, arousal: 0.4, labels: ["闷"] },
    scores: { self_relevance: 0.6, novelty: 0.4, user_signal: 0.7, goal_relevance: 0.3 },
    cards: [
      {
        title: "他说上线前一晚没睡，声音发干",
        detail: "他讲的时候语气很平，反而让我觉得更难受。",
        kind: "event",
        status: "active",
        keywords: ["上线", "熬夜"],
        entities: ["公司"],
      },
    ],
    ...over,
  });
}

async function write(env: ReturnType<typeof tmpEnv>["env"], ap = appraisal(), traceFrom: number | null = null) {
  const ep = openEpisode(env.db, Date.now(), "system", "t");
  return writeCards(env, ap, {
    now: Date.now(),
    episodeId: ep,
    personId: 1,
    traceFrom,
    traceTo: traceFrom,
  });
}

test("v3 闭合：attention / meant_to_me / not_known 真的落库了（v2 里前两个每轮被丢弃）", async () => {
  const { dir, env } = tmpEnv();
  const r = await write(env);
  const card = getCard(env.db, r.ids[0])!;

  assert.ok(card.attention && card.attention.includes("没睡"), `attention 应落库，实际 ${card.attention}`);
  assert.ok(
    card.meant_to_me && card.meant_to_me.includes("不太舒服"),
    `meant_to_me 应落库，实际 ${JSON.stringify(card.meant_to_me)}`,
  );
  assert.ok(card.not_known && card.not_known.includes("嫌我慢"));
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("v3 闭合：卡片骨架会渲染「视角」三行（◎ 注意到的 / ○ 没懂的）", async () => {
  const { dir, env } = tmpEnv();
  const r = await write(env);
  const card = getCard(env.db, r.ids[0])!;
  const rc: RetrievedCard = toRetrievedCard(card, 0.8, "fts", "昨天", null, false);

  const text = renderCards([rc]);
  assert.ok(text.includes("◎ 我当时注意到的是"), text);
  assert.ok(text.includes("○ 我当时没懂"), text);
  assert.ok(text.includes("没睡"));
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("v3 闭合：thread.summary 会进提示词，且同一条线只渲染一次", async () => {
  const { dir, env } = tmpEnv();
  const r = await write(env);
  const card = getCard(env.db, r.ids[0])!;
  // 手工造一条线（真实流程是巩固时写的）
  env.db.prepare("INSERT INTO thread(id, title, summary, card_count) VALUES (1, ?, ?, 2)").run("上线的事", "从一开始的熬夜救火，到上线还是崩了，现在他说不怪我。");
  env.db.prepare("UPDATE card SET thread_id = 1 WHERE id = ?").run(card.id);

  const row = getCard(env.db, card.id)!;
  const a: RetrievedCard = toRetrievedCard(row, 0.8, "fts", "昨天", { title: "上线的事", summary: "从一开始的熬夜救火，到上线还是崩了，现在他说不怪我。" }, false);
  const b: RetrievedCard = { ...a, id: 999, fromThread: true };

  const text = renderCards([a, b]);
  const hits = text.split("这条线后来的变化").length - 1;
  assert.equal(hits, 1, `同一条线的演变只该渲染一次，实际 ${hits} 次`);
  assert.ok(text.includes("上线还是崩了"));
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("v3 因果链：编码时声明的 links 会写进 card_link，并被串线采信", async () => {
  const { dir, env } = tmpEnv();
  const first = await write(env);

  const second = await write(
    env,
    appraisal({
      cards: [
        {
          title: "他说上线还是崩了，这次不怪我",
          detail: "他说这句话的时候很快，像怕我多想。",
          kind: "event",
          status: "active",
          keywords: ["上线", "崩"],
          entities: [],
          links: [{ card_id: first.ids[0], relation: "effect" }],
        },
      ],
    }),
  );

  const links = linksOfCard(env.db, second.ids[0]);
  assert.equal(links.length, 1, "应该有一条声明过的因果");
  assert.equal(links[0].to_id, first.ids[0]);
  assert.equal(links[0].relation, "effect");

  // 两张卡的 keywords 有重合，但**先看声明**：即便重合不存在，它们也该成一条线
  const rep = formThreads(env, Date.now());
  assert.ok(rep.declared >= 1, `应采信 1 条声明边，实际 ${rep.declared}`);
  const a = getCard(env.db, first.ids[0])!;
  const b = getCard(env.db, second.ids[0])!;
  assert.ok(a.thread_id && a.thread_id === b.thread_id, "声明过的两张卡必须同线");

  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("编出来的编号会被丢掉，不会把无关的两张卡绑在一起", async () => {
  const { dir, env } = tmpEnv();
  const first = await write(env);
  const second = await write(
    env,
    appraisal({
      cards: [
        {
          title: "他问我明天几点到",
          detail: "我说八点半。他嗯了一声。",
          kind: "event",
          status: "active",
          keywords: ["时间"],
          entities: [],
          links: [{ card_id: 99999, relation: "cause" }],
        },
      ],
    }),
  );
  assert.equal(linksOfCard(env.db, second.ids[0]).length, 0, "不存在的编号必须被丢弃");
  assert.ok(first.ids[0] > 0);
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("confidence 会真的落库（v2 恒为 1，等于这一列没用）", async () => {
  const { dir, env } = tmpEnv();
  const r = await write(
    env,
    appraisal({
      cards: [
        {
          title: "他好像下周要去搬家",
          detail: "他没明说，我猜的。",
          kind: "plan",
          status: "uncertain",
          keywords: ["搬家"],
          entities: [],
          confidence: 0.4,
        },
      ],
    }),
  );
  assert.equal(getCard(env.db, r.ids[0])!.confidence, 0.4);
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("表达审计：写进去、读得出来（/audit 的数据源）", () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  logExpressAudit(env.db, {
    ts: now,
    turnId: 1,
    kind: "reply",
    intent: "deflect",
    sentences: 4,
    chars: 40,
    maxSentences: 2,
    repeatRatio: 0.72,
    bannedHits: ["我理解你的感受"],
    violations: [
      { code: "too_many_sentences", detail: "4 > 2" },
      { code: "banned_phrase", detail: "踩了禁语" },
    ],
    retried: true,
    fixed: false,
    saysNothing: false,
    silenceKind: null,
    breaksMotivation: true,
  });

  const stats = auditStats(env.db, now - 1000);
  assert.equal(stats.length, 1);
  assert.equal(Number(stats[0].over_limit), 1);
  assert.equal(Number(stats[0].breaks), 1);
  assert.equal(Number(stats[0].retried), 1);

  const rows = all<{ violations: string }>(env.db, "SELECT violations FROM express_audit");
  assert.ok(rows[0].violations.includes("too_many_sentences"));
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

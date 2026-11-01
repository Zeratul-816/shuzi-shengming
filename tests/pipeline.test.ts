import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEnv } from "../src/env.ts";
import { Brain } from "../src/brain.ts";
import { consolidate } from "../src/memory/consolidate.ts";
import { activeSelfSheet, insertCard, liveCards, primaryPerson } from "../src/store/repos.ts";
import { loadPersona, personaDrift, seedPersona } from "../src/express/persona.ts";
import { assemble } from "../src/express/assemble.ts";
import { parseTimeHint, parseEventAt } from "../src/shared/timeparse.ts";

function tmpEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-pipe-"));
  const env = createEnv({ dbPath: path.join(dir, "t.db"), dataDir: dir, provider: "mock" });
  return { dir, env };
}

test("人设编译：persona → self_sheet v1 + 稳定 system 提示词", () => {
  const { dir, env } = tmpEnv();
  const sheet = activeSelfSheet(env.db);
  assert.ok(sheet, "启动应自动编译出 self_sheet");
  assert.equal(sheet!.version, 1);
  assert.ok(env.persona.system.includes("want_detail"), "system 应含新输出格式");
  assert.equal(loadPersona().hash, env.persona.hash);
  assert.equal(personaDrift(env.db).stale, false);
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("端到端：一轮对话写下卡片，后续能按关键词召回", async () => {
  const { dir, env } = tmpEnv();
  const brain = new Brain(env);

  const r = await brain.turn("我今天上线，救火救了五个小时，现在脑子是糊的。");
  await brain.settle();

  assert.equal(r.kind, "reply");
  const cards = liveCards(env.db, 20);
  assert.ok(cards.length >= 1, `应至少写下一张卡片，实际 ${cards.length}`);
  assert.ok(
    cards.some((c) => c.title.includes("上线") || (c.keywords ?? "").includes("上线")),
    `卡片应含关键词，实际：${cards.map((c) => c.title).join(" | ")}`,
  );

  const hits = await brain.recallProbe("上线");
  assert.ok(hits.length > 0, "应该能召回");
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("时间窗：问「昨天」不会把今天的事排在最前面", async () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const DAY = 86_400_000;

  const mk = (title: string, eventAt: number) =>
    insertCard(env.db, {
      kind: "event",
      status: "active",
      title,
      detail: "细节。",
      personId: null,
      eventAt,
      eventHint: null,
      timePrecision: "exact",
      validFrom: null,
      validTo: null,
      keywords: ["项目"],
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

  const yesterdayStart = new Date(now).setHours(0, 0, 0, 0) - DAY;
  const todayCard = mk("刚才说的事：项目要延期", now - 3_600_000);
  const yesterdayCard = mk("昨天说的事：项目上线失败", yesterdayStart + 20 * 3_600_000);

  const hits = await new Brain(env).recallProbe("昨天那个项目的事", now);
  assert.ok(hits.length > 0);
  assert.equal(hits[0].id, yesterdayCard, `「昨天」应把昨天的卡片排第一，实际第一是 #${hits[0].id}（今天=#${todayCard}）`);

  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("状态：已失效的卡片即便关键词命中，也应排在有效卡片后面", async () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const mk = (title: string, status: "active" | "expired") =>
    insertCard(env.db, {
      kind: "fact",
      status,
      title,
      detail: "细节。",
      personId: null,
      eventAt: now - 5 * 86_400_000,
      eventHint: null,
      timePrecision: "day",
      validFrom: null,
      validTo: null,
      keywords: ["搬家"],
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

  const expired = mk("他说下周要搬家", "expired");
  const active = mk("他已经搬完家了", "active");

  const hits = await new Brain(env).recallProbe("搬家的事怎么样了", now);
  assert.equal(hits[0].id, active, `有效卡片应排第一，实际 #${hits[0].id}（expired=#${expired}）`);
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("时间解析：常用中文时间词", () => {
  const now = Date.now();
  assert.equal(parseTimeHint("昨天怎么样")?.label, "昨天");
  assert.equal(parseTimeHint("上周三说的")?.label, "上周");
  assert.equal(parseTimeHint("最近有点累")?.label, "最近");
  assert.ok(parseTimeHint("今天") !== null);
  assert.equal(parseTimeHint("随便聊聊"), null);

  const parsed = parseEventAt("2026-02-10T21:30", now);
  assert.equal(parsed.precision, "exact");
  assert.equal(new Date(parsed.at).getFullYear(), 2026);
  assert.equal(parseEventAt(undefined, now).precision, "vague");
});

test("提示词组装：卡片骨架与「原话」是两个分区，骨架里不放 detail 全文", () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const card = {
    intent: "reply" as const,
    drive: "connection" as const,
    urgency: 0.5,
    why: "他在跟我说话。",
    desired_outcome: "接住他的话",
    must_include: [],
    must_not: ["复述他刚说的话"],
    tone: "自然",
    max_sentences: 3,
    seed_card_ids: [],
    attempt: 0,
  };
  const p = assemble(env, {
    now,
    person: primaryPerson(env.db, now),
    self: activeSelfSheet(env.db),
    card,
    cards: [
      {
        id: 7,
        kind: "event",
        status: "expired",
        title: "他说下周要搬家",
        detail:
          "他讲这件事的时候声音有点低，" + "我听着心里发紧但也说不出什么，".repeat(5) + "尾巴标记XYZ",
        event_at: now,
        created_at: now,
        time_label: "上周三",
        event_hint: "上周三",
        time_precision: "day",
        keywords: ["搬家"],
        entities: [],
        salience: 0.6,
        strength: 0.6,
        confidence: 1,
        valence: -0.2,
        arousal: 0.4,
        thread_id: null,
        thread_title: null,
        thread_summary: null,
        attention: null,
        not_known: null,
        score: 0.8,
        channel: "fts",
        fromThread: false,
      },
    ],
    recent: [],
    loops: [],
    currentUtterance: "船票订好了吗",
  });

  assert.deepEqual(
    p.sections.map((s) => s.name),
    ["self", "person", "motivation", "memories", "details", "recent", "loops", "utterance"],
  );
  const memories = p.sections.find((s) => s.name === "memories")!.text;
  assert.ok(memories.includes("已失效"), "状态必须渲染出来");
  // v2 初版完全不给 detail，卡片退化成一句标题；现在给前 60 字摘录，但**不给全**
  assert.ok(memories.includes("他讲这件事的时候声音有点低"), "骨架应包含 detail 摘录（语气依据）");
  assert.ok(!memories.includes("尾巴标记XYZ"), "摘录必须截断，不能把 detail 全文灌进去");
  assert.ok(memories.includes("↳"), "摘录用 ↳ 标记，以区别于原话");
  assert.ok(p.user.includes("want_detail") || p.system.includes("want_detail"));
  assert.ok(p.user.includes("船票订好了吗"), "本轮用户原句必须进提示词");
  assert.ok(p.user.lastIndexOf("船票订好了吗") > p.user.lastIndexOf("之前的对话"), "原句要排在对话记录之后");
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("巩固：能在卡片制下跑完并给出报告", async () => {
  const { dir, env } = tmpEnv();
  const brain = new Brain(env);
  await brain.turn("上线一直在报错，我修到凌晨三点。");
  await brain.settle();

  const rep = await consolidate(env, Date.now());
  assert.ok(rep.liveBefore >= 1);
  assert.ok(rep.liveAfter <= rep.liveBefore);
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("回归：本轮用户原句必须出现在本轮提示词里（回复慢一回合的根因）", async () => {
  const { dir, env } = tmpEnv();
  const brain = new Brain(env);

  await brain.turn("明天几点出发？");
  await brain.settle();

  const THIS_TURN = "船票订好了吗，暗号是紫罗兰";
  const r2 = await brain.turn(THIS_TURN);
  await brain.settle();

  assert.ok(r2.prompt.user.includes("紫罗兰"), "本轮原句缺失 → 模型只能回上一轮的话");
  const utt = r2.prompt.sections.at(-1)!;
  assert.equal(utt.name, "utterance", "「他刚才说」必须是最后一个分区");
  assert.ok(utt.text.includes("紫罗兰"));

  // 同时确认对话记录里已经不含本轮（它只到上一轮为止，避免重复）
  const recent = r2.prompt.sections.find((s) => s.name === "recent")!;
  assert.ok(!recent.text.includes("紫罗兰"), "对话记录应只到上一轮");

  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
test("重编译人设：升版而不是撞主键（/reseed 崩过的那个 bug）", () => {
  const { dir, env } = tmpEnv();
  const v1 = activeSelfSheet(env.db)!;
  assert.equal(v1.version, 1);

  // 模拟 /reseed：deactivate 由 insertSelfSheet 在同一事务里接管
  const r2 = seedPersona(env.db, Date.now(), { force: true });
  assert.equal(r2.version, 2, "应升到 v2");
  const rows = env.db.prepare("SELECT version, active FROM self_sheet ORDER BY version").all() as {
    version: number;
    active: number;
  }[];
  assert.deepEqual(
    rows.map((r) => [r.version, r.active]),
    [
      [1, 0],
      [2, 1],
    ],
    "旧版保留但失活，新版生效",
  );

  const r3 = seedPersona(env.db, Date.now());
  assert.equal(r3.seeded, false, "启动路径必须幂等：已有生效版本时不重复插入");

  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("零生效的自叙事能自愈（失败中途留下的坏状态）", () => {
  const { dir, env } = tmpEnv();
  // 复现 /reseed 失败后的现场：有行，但一行都不 active
  env.db.prepare("UPDATE self_sheet SET active = 0").run();
  assert.equal(activeSelfSheet(env.db), undefined);

  const recovered = seedPersona(env.db, Date.now());
  assert.equal(recovered.seeded, true);
  const active = activeSelfSheet(env.db);
  assert.ok(active, "启动时应该自动补一版生效的自我叙事");
  assert.equal(active!.version, 2, "接着 MAX(version) 往上走，而不是又从 1 开始");

  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
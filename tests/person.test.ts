import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEnv } from "../src/env.ts";
import { Brain } from "../src/brain.ts";
import {
  addAlias,
  aliasesOf,
  allPersons,
  awakeningCount,
  getPerson,
  insertCard,
  openEpisode,
  primaryPerson,
  recentAwakenings,
} from "../src/store/repos.ts";
import { all } from "../src/store/db.ts";
import {
  applyPeopleMentions,
  applySpeakerDraft,
  bindIdentity,
  dossierOf,
  extractSelfIntro,
  looksLikeSamePerson,
  MAX_ASKS,
  matchAlias,
  refreshDossier,
  resolveIdentityFromText,
  shouldAskIdentity,
} from "../src/memory/person.ts";
import { writeCards } from "../src/memory/cards.ts";
import { AppraisalSchema } from "../src/shared/types.ts";
import { readUserTurn } from "../src/motivation/reader.ts";
import { evaluateReply } from "../src/motivation/intents.ts";
import { defaultState } from "../src/motivation/state.ts";

function tmpEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-person-"));
  const env = createEnv({ dbPath: path.join(dir, "t.db"), dataDir: dir, provider: "mock" });
  return { dir, env };
}

// ══════════════════════════════════════════════════════════
//  ① 名字抽取：宁可不认，也不要认错
// ══════════════════════════════════════════════════════════
test("自报名字：认得出四种说法", () => {
  assert.equal(extractSelfIntro("我是开发者"), "开发者");
  assert.equal(extractSelfIntro("我是开发者，之前来过"), "开发者");
  assert.equal(extractSelfIntro("叫我小林"), "小林");
  assert.equal(extractSelfIntro("我叫阿哲。"), "阿哲");
  assert.equal(extractSelfIntro("我姓林"), "林");
});

test("抽名字是尽力而为：抽到什么就绑什么（误会是原料，不是缺陷）", () => {
  // 「我是说……」会被抽成"说"。这当然是错的。
  // 但错的成本只是她一段时间里管他叫"说"，而他下次正经说一句就改过来了。
  // 所以测试**不规定答案应该是什么**，只规定"抽出来的东西会被采信"。
  const text = "我是说，你可能误会了";
  const got = extractSelfIntro(text);
  assert.ok(got, "尽力而为：它总会给一个答案");

  const { dir, env } = tmpEnv();
  const now = Date.now();
  const p = primaryPerson(env.db, now);
  const r = resolveIdentityFromText(env, text, now);
  assert.ok(r, "抽到了就该绑");
  assert.equal(r!.label, got);
  assert.equal(getPerson(env.db, p.id)!.display_name, got, "机制：抽到什么就记成什么");
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("绑错了能改过来：他后来说清楚，称呼就换了，旧叫法留着", () => {
  // 这一条才是「允许误会」得以成立的前提 ——
  // 没有可纠正性，允许误会等于允许永久损坏。
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const p = primaryPerson(env.db, now);

  bindIdentity(env, p.id, "说", { introduced: true, now });
  assert.equal(getPerson(env.db, p.id)!.display_name, "说");

  resolveIdentityFromText(env, "我叫小林", now);
  assert.equal(getPerson(env.db, p.id)!.display_name, "小林", "新的说法覆盖称呼");

  const aliases = aliasesOf(env.db, p.id).map((a) => a.alias);
  assert.ok(aliases.includes("小林"), "新名字记下了");
  assert.ok(aliases.includes("说"), "旧叫法留着 —— 她确实这么叫过他一段时间");

  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("「是我」指认只在恰好一个人的时候才敢认", () => {
  assert.equal(looksLikeSamePerson("是我"), true);
  assert.equal(looksLikeSamePerson("还是我，昨天那个"), true);
  assert.equal(looksLikeSamePerson("我最近很累"), false);
});

// ══════════════════════════════════════════════════════════
//  ② 她自己的名字不设防
// ══════════════════════════════════════════════════════════
test("他说自己叫「艾拉」也会被记下来（误会允许存在，能被纠正就够了）", () => {
  // 第一版这里是一条硬规则：她的名字是黑名单，谁也不能拿它当名字。
  // 删掉的理由：那种防线保证的是"内容正确"，而这个项目要的是机制跑顺。
  // 何况"有人说自己叫艾拉"本身是个很好的场面，挡掉它才是浪费。
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const p = primaryPerson(env.db, now);

  const r = resolveIdentityFromText(env, "我是艾拉", now);
  assert.ok(r, "不该因为这两个字是她自己的名字就拒绝");
  assert.equal(getPerson(env.db, p.id)!.display_name, "艾拉");

  // 纠不纠正得了，才是要保证的那件事
  resolveIdentityFromText(env, "我叫林工", now);
  assert.equal(getPerson(env.db, p.id)!.display_name, "林工");

  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("提到「艾拉」也会被当成人（不做语义甄别，只做机制）", () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const map = applyPeopleMentions(env, [{ name: "艾拉", relation: "" }], now);
  assert.equal(map.size, 1, "抽到什么就建什么");
  assert.equal(allPersons(env.db).length >= 1, true);
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════
//  ③ 冷启动：她应该先问"你是谁"
// ══════════════════════════════════════════════════════════
test("新库的第一张档案是空的：dossier_status=unknown，没有名字", () => {
  const { dir, env } = tmpEnv();
  const p = primaryPerson(env.db, Date.now());
  assert.equal(p.dossier_status, "unknown");
  assert.equal(p.display_name, null);
  assert.equal(p.asked_count, 0);
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("不知道是谁的时候，回应型意图选 ask_identity（权重压过其它接法）", () => {
  const s = defaultState(Date.now());
  const read = readUserTurn("你还记得我吗");
  const unknown = evaluateReply({
    now: Date.now(),
    state: s,
    read,
    openLoops: [],
    identity: { shouldAsk: true, known: false, askedCount: 0 },
  });
  assert.equal(unknown.candidate.intent, "ask_identity");
  assert.equal(unknown.candidate.max_sentences, 1, "问一句就够");
  assert.ok(unknown.candidate.must_not.some((m) => m.includes("客服腔")));
  assert.ok(unknown.candidate.must_not.some((m) => m.includes("假装认识")));

  // 知道是谁之后就不该再问
  const known = evaluateReply({
    now: Date.now(),
    state: s,
    read,
    openLoops: [],
    identity: { shouldAsk: false, known: true, askedCount: 0 },
  });
  assert.notEqual(known.candidate.intent, "ask_identity");
});

test("问的额度：同一次苏醒只问一次；累计三次不再问；知道是谁就不问", () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const p = primaryPerson(env.db, now);

  assert.equal(shouldAskIdentity(env, p.id, { askedThisAwakening: false }), true);
  assert.equal(shouldAskIdentity(env, p.id, { askedThisAwakening: true }), false, "同一次苏醒只问一次");

  env.db.prepare("UPDATE person SET asked_count = ? WHERE id = ?").run(MAX_ASKS, p.id);
  assert.equal(shouldAskIdentity(env, p.id, { askedThisAwakening: false }), false, "问三次他都不说就不问了");

  env.db.prepare("UPDATE person SET asked_count = 0, dossier_status = 'known' WHERE id = ?").run(p.id);
  assert.equal(shouldAskIdentity(env, p.id, { askedThisAwakening: false }), false);

  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════
//  ④ 绑定：他说了名字之后，档案才开始被填
// ══════════════════════════════════════════════════════════
test("他自报名字 → 别名 + 称呼 + 状态 known，问的账一笔勾销", () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const p = primaryPerson(env.db, now);
  env.db.prepare("UPDATE person SET asked_count = 2 WHERE id = ?").run(p.id);

  const r = resolveIdentityFromText(env, "我是开发者，之前来过", now);
  assert.ok(r);
  assert.equal(r!.introduced, true);

  const after = getPerson(env.db, p.id)!;
  assert.equal(after.display_name, "开发者");
  assert.equal(after.dossier_status, "known");
  assert.equal(after.asked_count, 0, "他报了名，之前问过的账要清掉");
  assert.ok(after.self_intro_at);

  const aliases = aliasesOf(env.db, p.id).map((a) => a.alias);
  assert.deepEqual(aliases, ["开发者"]);
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("认识之后，他换个说法提到自己也能对上（别名索引）", () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const p = primaryPerson(env.db, now);
  bindIdentity(env, p.id, "开发者", { introduced: true, now });
  env.db.prepare("UPDATE person SET dossier_status = 'unknown' WHERE id = ?").run(p.id);

  const r = resolveIdentityFromText(env, "开发者，你还在吗", now);
  assert.ok(r, "命中别名就该认出来");
  assert.equal(r!.personId, p.id);
  assert.equal(r!.introduced, false);
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("「是我」：只有一个人时认成 provisional，不是 known", () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const p = primaryPerson(env.db, now);
  const r = resolveIdentityFromText(env, "是我", now);
  assert.ok(r);
  assert.equal(r!.introduced, false);
  assert.equal(getPerson(env.db, p.id)!.dossier_status, "provisional", "没报名，只到'大概是他'");
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("编码器回报的 speaker 也能绑定（第二通道，晚一轮生效）", () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const p = primaryPerson(env.db, now);
  applySpeakerDraft(env, { label: "小林", introduced: true }, now, null);
  assert.equal(getPerson(env.db, p.id)!.display_name, "小林");
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════
//  ⑤ 归户：卡片要知道自己关于谁
// ══════════════════════════════════════════════════════════
function appraisalWith(cards: unknown[], extra: Record<string, unknown> = {}) {
  return AppraisalSchema.parse({
    attention: "",
    meant_to_me: "",
    felt: { valence: 0, arousal: 0.3, labels: [] },
    scores: { self_relevance: 0.6, novelty: 0.4, user_signal: 0.5, goal_relevance: 0.3 },
    cards,
    open_loops: [],
    ...extra,
  });
}

test("卡片按 about 归到不同的人（提到「老王」的那张不归他）", async () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const me = primaryPerson(env.db, now);
  bindIdentity(env, me.id, "开发者", { introduced: true, now });

  const ap = appraisalWith(
    [
      { title: "他说做实验会忘时间", detail: "他讲的时候很平静。", kind: "fact", status: "active", keywords: ["实验"], entities: [] },
      { title: "老王说他儿子考上大学了", detail: "他转述的，语气挺高兴。", kind: "fact", status: "active", keywords: ["儿子"], entities: [], about: "老王" },
    ],
    { people: [{ name: "老王", relation: "同事" }] },
  );
  const peopleMap = applyPeopleMentions(env, ap.people, now);
  assert.equal(peopleMap.has("老王"), true, "提到的人应该有档案");

  const ep = openEpisode(env.db, now, "system", "t");
  const res = await writeCards(env, ap, {
    now,
    episodeId: ep,
    personId: me.id,
    peopleMap,
    traceFrom: null,
    traceTo: null,
  });
  assert.equal(res.inserted, 2);
  assert.equal(res.peopleTouched.length, 2, "两张卡应该分属两个人");

  const aboutMe = all<{ person_id: number }>(env.db, "SELECT person_id FROM card WHERE title LIKE '%实验%'");
  const aboutWang = all<{ person_id: number }>(env.db, "SELECT person_id FROM card WHERE title LIKE '%老王%'");
  assert.equal(aboutMe[0].person_id, me.id);
  assert.notEqual(aboutWang[0].person_id, me.id);
  assert.equal(getPerson(env.db, aboutWang[0].person_id)!.name, "老王");
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("about 指不到人时回落到他，不凭空造档案", async () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const me = primaryPerson(env.db, now);
  const ap = appraisalWith([
    { title: "他说那个人很麻烦", detail: "他没细说，只提了一句。", kind: "event", status: "uncertain", keywords: [], entities: [], about: "那个人" },
  ]);
  const ep = openEpisode(env.db, now, "system", "t");
  await writeCards(env, ap, { now, episodeId: ep, personId: me.id, traceFrom: null, traceTo: null });
  const rows = all<{ person_id: number }>(env.db, "SELECT person_id FROM card");
  assert.equal(rows[0].person_id, me.id);
  assert.equal(allPersons(env.db).length, 1, "不该因为一句话多出一个人");
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════
//  ⑥ 档案内容
// ══════════════════════════════════════════════════════════
test("档案会随卡片长出来：traits 来自卡片标题，一字不改", () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const p = primaryPerson(env.db, now);
  bindIdentity(env, p.id, "开发者", { introduced: true, now });
  insertCard(env.db, {
    kind: "fact",
    status: "active",
    title: "他做实验会忘掉时间",
    detail: "他说回来才发现过了很久。",
    personId: p.id,
    eventAt: now,
    eventHint: null,
    timePrecision: "day",
    validFrom: null,
    validTo: null,
    keywords: ["实验"],
    entities: [],
    salience: 0.8,
    valence: 0,
    arousal: 0.3,
    confidence: 0.9,
    threadId: null,
    episodeId: null,
    traceFrom: null,
    traceTo: null,
    notKnown: null,
  });
  refreshDossier(env, p.id, now);
  const d = dossierOf(env, p.id, now)!;
  assert.equal(d.status, "known");
  assert.equal(d.displayName, "开发者");
  assert.equal(d.aliases.includes("开发者"), true);
  assert.equal(d.traits[0].trait, "他做实验会忘掉时间");
  assert.equal(d.traits[0].confidence, 0.9);
  assert.equal(d.cardCount, 1);
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("不知道是谁的时候，档案会自己说出「还不知道什么」", () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const p = primaryPerson(env.db, now);
  const d = dossierOf(env, p.id, now)!;
  assert.equal(d.status, "unknown");
  assert.ok(d.openQuestions.includes("我在跟谁说话"));
  assert.ok(d.openQuestions.includes("他叫什么"));
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("matchAlias：长别名优先（「开发者」不该被「开发」抢走）", () => {
  const { dir, env } = tmpEnv();
  const now = Date.now();
  const p = primaryPerson(env.db, now);
  addAlias(env.db, p.id, "开发", { now });
  addAlias(env.db, p.id, "开发者", { now });

  const hit = matchAlias(env, "开发者你还在吗", [
    { person_id: p.id, alias: "开发", confidence: 1 },
    { person_id: p.id, alias: "开发者", confidence: 1 },
  ]);
  assert.equal(hit?.alias, "开发者");
  assert.equal(hit?.personId, p.id);

  const miss = matchAlias(env, "你还在吗", [{ person_id: p.id, alias: "开发者", confidence: 1 }]);
  assert.equal(miss, null, "没提到叫法就不该硬认");
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════
//  ⑦ 唤醒事件
// ══════════════════════════════════════════════════════════
test("每次 Brain 醒来都是一个事件，第二次是 resume", async () => {
  const { dir, env } = tmpEnv();
  const b1 = new Brain(env);
  await b1.settle();
  assert.equal(awakeningCount(env.db), 1);
  const rows1 = recentAwakenings(env.db, 5);
  assert.equal(rows1[0].mode, "cold_start");
  assert.equal(rows1[0].identity_known, 0, "醒来时不知道对面是谁");
  b1.close();

  const b2 = new Brain(env);
  await b2.settle();
  assert.equal(awakeningCount(env.db), 2);
  assert.equal(recentAwakenings(env.db, 5)[0].mode, "resume");
  b2.close();
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("冷启动第一轮：她问「你是谁」，并把它记在唤醒事件上", async () => {
  const { dir, env } = tmpEnv();
  const brain = new Brain(env);
  await brain.settle();
  const r = await brain.turn("你还记得我吗");
  await brain.settle();

  assert.equal(r.card.intent, "ask_identity", `第一轮应该先问身份，实际 ${r.card.intent}`);
  const aw = recentAwakenings(env.db, 1)[0];
  assert.equal(aw.asked_identity, 1, "问过就要记下来");
  const p = primaryPerson(env.db, Date.now());
  assert.equal(p.asked_count, 1);

  brain.close();
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("他说了名字之后，下一轮就不再问，并且档案里有他", async () => {
  const { dir, env } = tmpEnv();
  const brain = new Brain(env);
  await brain.settle();

  await brain.turn("你好");
  await brain.settle();
  const r2 = await brain.turn("我是开发者");
  await brain.settle();
  assert.notEqual(r2.card.intent, "ask_identity", "他已经报名了，不该再问");

  const p = primaryPerson(env.db, Date.now());
  assert.equal(p.display_name, "开发者");
  assert.equal(p.dossier_status, "known");

  const r3 = await brain.turn("今天上线又崩了");
  await brain.settle();
  assert.notEqual(r3.card.intent, "ask_identity");
  assert.ok(r3.prompt.user.includes("开发者"), "档案应该进提示词");
  assert.ok(!r3.prompt.user.includes("我还不知道我在跟谁说话"), "已经知道了就不该这么说");

  brain.close();
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("他叫我什么会记在唤醒事件上", async () => {
  // ★ 自带一份最小 persona，而不是用仓库里那份。
  //   仓库带的是「白模」——它按设计**没有**自己的名字（"我还不知道自己是谁"），
  //   所以 selfNames 是空的。这条测试要验的是"他叫我名字时会被记下来"这个机制，
  //   不该依赖仓库那份人设恰好配了什么名字。
  const pdir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-persona-"));
  fs.writeFileSync(path.join(pdir, "identity.md"), "# 我是谁\n\n一个用来测试的人设。", "utf8");
  fs.writeFileSync(
    path.join(pdir, "voice.json"),
    JSON.stringify({ positive: ["简短。"], negative: ["不复述。"], banned_phrases: [], examples_good: [], examples_bad: [] }),
    "utf8",
  );
  fs.writeFileSync(path.join(pdir, "seed-self.md"), "我在测试里。", "utf8");
  fs.writeFileSync(path.join(pdir, "self.json"), JSON.stringify({ names: ["小助"] }), "utf8");

  const prev = process.env.DH_PERSONA_DIR;
  process.env.DH_PERSONA_DIR = pdir;
  const { dir, env } = tmpEnv();
  try {
    const myName = env.persona.selfNames[0];
    assert.equal(myName, "小助", "测试前提：self.json 里的名字要被读进来");

    const brain = new Brain(env);
    await brain.settle();
    await brain.turn(`${myName}，在吗`);
    await brain.settle();
    const aw = recentAwakenings(env.db, 1)[0];
    assert.equal(aw.called_as, myName, "他叫我什么，要记在这一次唤醒上");
    brain.close();
  } finally {
    env.close();
    if (prev === undefined) delete process.env.DH_PERSONA_DIR;
    else process.env.DH_PERSONA_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(pdir, { recursive: true, force: true });
  }
});

/**
 * 离线评测 + 真机试跑。
 *
 *   npm run eval                # 只跑确定性检查（不调模型，0 成本，几秒）
 *   npm run eval -- --live      # 再用真模型跑 6 轮，打印对话与合规表
 *   npm run eval -- --live --judge   # 再加一个跨厂商 judge 打三档分
 *
 * ── 为什么要有这个文件 ───────────────────────────────────
 *   设计文档 §10 写得很对："没有这个评测集，你会在第 3 周开始凭感觉改提示词。"
 *   而 v2 的尴尬是：所有机制都在，但没有任何东西能告诉你"这次改动是变好还是变坏"。
 *
 *   这里刻意分两层：
 *     第一层**不需要模型**——时间窗、状态压制、去重、串线、反刍、审计规则，
 *       全是确定性的，跑一万遍结果一样。改检索参数时先跑这一层。
 *     第二层才是真机——它验证的是"像不像人"，那是 judge 的活，也是唯一需要花钱的部分。
 *
 *   纪律：两个子命令都用**独立的一次性库**（data/eval.db），
 *   绝不碰 data/memory.db。
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.ts";
import { createEnv } from "../src/env.ts";
import type { Env } from "../src/env.ts";
import { Brain } from "../src/brain.ts";
import { refreshStatuses } from "../src/memory/status.ts";
import { formThreads } from "../src/memory/consolidate.ts";
import { recall } from "../src/memory/retrieve.ts";
import { auditSpeech } from "../src/express/verify.ts";
import { renderCards } from "../src/express/assemble.ts";
import { readUserTurn } from "../src/motivation/reader.ts";
import { evaluateReply } from "../src/motivation/intents.ts";
import { defaultState } from "../src/motivation/state.ts";
import type { MotivationCard, MotivationState } from "../src/shared/types.ts";
import { chatJson } from "../src/llm/provider.ts";
import { z } from "zod";
import {
  getCard,
  insertCard,
  linksOfCard,
  liveCards,
  openEpisode,
  primaryPerson,
  recentAwakenings,
  recentByCreation,
} from "../src/store/repos.ts";
import { dossierOf } from "../src/memory/person.ts";
import type { CardRow } from "../src/store/repos.ts";
import { writeCards } from "../src/memory/cards.ts";
import { AppraisalSchema } from "../src/shared/types.ts";

const DAY = 86_400_000;

/** 直接调 writeCards 的小包装：把半成品对象过一遍 schema，拿到默认值 */
async function writeCardsSafe(
  env: Env,
  ap: Parameters<typeof AppraisalSchema.parse>[0],
  episodeId: number,
) {
  const parsed = AppraisalSchema.parse(ap);
  return writeCards(env, parsed, {
    now: Date.now(),
    episodeId,
    personId: 1,
    traceFrom: null,
    traceTo: null,
  });
}
const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ${C.green("✓")} ${name}`);
    })
    .catch((e) => {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${name} —— ${msg}`);
      console.log(`  ${C.red("✗")} ${name}`);
      console.log(C.dim(`      ${msg}`));
    });
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function eq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}：期望 ${String(expected)}，实际 ${String(actual)}`);
}

/** 一次性评测库。每次都重建，保证结果可复现。 */
function freshEnv(): { env: Env; dir: string } {
  const dir = path.join(ROOT, "data", "eval-run");
  fs.mkdirSync(dir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(dir, "eval.db") + suffix, { force: true });
  const env = createEnv({ dbPath: path.join(dir, "eval.db"), dataDir: dir, provider: "mock" });
  primaryPerson(env.db, Date.now());
  return { env, dir };
}

function mk(
  env: Env,
  o: {
    title: string;
    detail?: string;
    kind?: "event" | "fact" | "plan" | "joke" | "preference" | "relation" | "self";
    status?: "active" | "expired" | "retracted" | "uncertain";
    eventAt: number;
    createdAt?: number;
    keywords?: string[];
    entities?: string[];
    salience?: number;
    valence?: number;
    arousal?: number;
    confidence?: number;
    validTo?: number | null;
  },
): number {
  return insertCard(env.db, {
    kind: o.kind ?? "event",
    status: o.status ?? "active",
    title: o.title,
    detail: o.detail ?? "细节若干，够长就行。",
    personId: 1,
    eventAt: o.eventAt,
    eventHint: null,
    timePrecision: "day",
    validFrom: null,
    validTo: o.validTo ?? null,
    keywords: o.keywords ?? [],
    entities: o.entities ?? [],
    salience: o.salience ?? 0.6,
    valence: o.valence ?? 0,
    arousal: o.arousal ?? 0.3,
    confidence: o.confidence ?? 1,
    threadId: null,
    episodeId: null,
    traceFrom: null,
    traceTo: null,
    notKnown: null,
    createdAt: o.createdAt,
  });
}

/** 回应型意图的纯函数版：不碰库，只问"这句话会选哪种接法" */
function pickReplyIntent(state: MotivationState, text: string, lastIntent?: MotivationState["lastIntent"]): string {
  const { candidate } = evaluateReply({
    now: Date.now(),
    state,
    read: readUserTurn(text),
    openLoops: [],
    lastIntent,
  });
  return candidate.intent;
}

/** 造一张回应型动机卡（评测用，不走 tick） */
function replyCardFor(intent: MotivationCard["intent"]): MotivationCard {
  return {
    intent,
    drive: "connection",
    urgency: 0.5,
    why: "他在跟我说话。",
    desired_outcome: "接住",
    must_include: [],
    must_not: [],
    tone: "自然",
    max_sentences: 3,
    seed_card_ids: [],
    attempt: 0,
  };
}

// ════════════════════════════════════════════════════════════
//  第一层：确定性检查（不调模型）
// ════════════════════════════════════════════════════════════
async function offline(): Promise<void> {
  console.log(C.bold("\n ① 时间语义"));
  {
    const { env } = freshEnv();
    const now = Date.now();
    const today = mk(env, { title: "项目今天要交，还在改", eventAt: now - 3_600_000, keywords: ["项目"] });
    const yesterdayStart = new Date(now).setHours(0, 0, 0, 0) - DAY;
    const yest = mk(env, {
      title: "项目昨天上线失败了",
      eventAt: yesterdayStart + 20 * 3_600_000,
      keywords: ["项目"],
    });

    await check("问「昨天」时，昨天那张排第一", async () => {
      const r = await recall(env, { now, turnId: -1, queryText: "昨天那个项目", card: null, personId: 1, noSerendipity: true, dryRun: true });
      assert(r.cards.length > 0, "什么都没召回");
      eq(r.cards[0].id, yest, "排序");
      assert(!r.cards.slice(0, 1).some((c) => c.id === today), "今天的事不该排第一");
    });

    await check("未来的计划卡不占「最近」通道", () => {
      const future = mk(env, {
        title: "他下周三要去上海出差",
        kind: "plan",
        eventAt: now + 5 * DAY,
        createdAt: now - DAY,
        keywords: ["出差"],
      });
      const recent = recentByCreation(env.db, now - 3 * DAY, 20).map((c) => c.id);
      assert(recent.includes(future), "昨天得知的将来事，仍算「最近聊过」");
      // 但三个月前得知的将来事不该在里面
      const stale = mk(env, {
        title: "他去年说要去西安出差",
        kind: "plan",
        eventAt: now + 2 * DAY,
        createdAt: now - 200 * DAY,
        keywords: ["出差"],
      });
      const recent2 = recentByCreation(env.db, now - 3 * DAY, 20).map((c) => c.id);
      assert(!recent2.includes(stale), "三个月前得知的计划不该占最近通道");
    });

    await check("时间驱动过期：过去的计划自动失效，未来的不动", () => {
      const past = mk(env, { title: "他说上周要去北京", kind: "plan", eventAt: now - 6 * DAY });
      const ahead = mk(env, { title: "他说明天要去修车", kind: "plan", eventAt: now + DAY });
      const rep = refreshStatuses(env, now);
      assert(rep.expired >= 1, "至少要失效一张");
      eq(getCard(env.db, past)!.status, "expired", "过去的计划");
      eq(getCard(env.db, ahead)!.status, "active", "未来的计划");
    });
    env.close();
  }

  console.log(C.bold("\n ② 状态与真实性（这套系统的核心承诺）"));
  {
    const { env } = freshEnv();
    const now = Date.now();

    await check("已失效的卡片即便关键词全中，也排在有效卡之后", async () => {
      const dead = mk(env, { title: "他说下周要搬家", status: "expired", eventAt: now - 5 * DAY, keywords: ["搬家"] });
      const live = mk(env, { title: "他已经搬完家了", eventAt: now - DAY, keywords: ["搬家"] });
      const r = await recall(env, { now, turnId: -1, queryText: "搬家的事怎么样了", card: null, personId: 1, noSerendipity: true, dryRun: true });
      eq(r.cards[0].id, live, "排序");
      assert(r.cards[0].id !== dead, "失效的不该第一");
    });

    await check("玩笑被乘性降权（同一段文字，joke 分低于 event）", async () => {
      // ★ 这里必须控制变量：用**同样的文字**建两张卡，只改 kind。
      //   一开始我写的断言是"玩笑卡永远排在事实卡后面"，结果挂了 ——
      //   因为两张卡标题不同，bm25 名次差（0.18）比 kindFactor 的扣分
      //   （0.75 × 0.49 ≈ 0.12）还大。
      //   这不是 bug，是这套设计的真实边界：**kindFactor 是软信号，压不过关键词名次**。
      //   真正防止"玩笑被当成事实"的，是 status/kind 标签进提示词
      //   + 表达层纪律（express.rules.md 里那三条）。
      //   评测只该测机制真的承诺过的那部分。
      const text = "他说要把公司买了然后去环游世界";
      // 用高分值让它俩都能过绝对下限（0.25），否则被截断的是两张而不是"降权的那张"
      const spec = { title: text, eventAt: now - 3_600_000, keywords: ["公司", "环游世界"], salience: 0.95 };
      const joke = mk(env, { ...spec, kind: "joke" });
      const event = mk(env, { ...spec, kind: "event" });
      // 空查询 = 只走"最近"通道，把关键词通道彻底摘掉。
      // 否则两张**文字完全相同**的卡片会拿到 1.0 / 0.5 两个不同的 bm25 名次分
      // （rankScore 没有并列处理），0.18 的名次差又会盖掉 0.75 的降权。
      // 这一步是为了隔离变量，不是为了掩盖问题 —— 名次差盖过降权这件事本身
      // 已经写进 README 的"已知边界"里。
      const r = await recall(env, { now, turnId: -1, queryText: "", card: null, personId: 1, noSerendipity: true, dryRun: true });
      const j = r.cards.find((c) => c.id === joke);
      const e = r.cards.find((c) => c.id === event);
      assert(j && e, `两张都该被召回（joke=${!!j} event=${!!e}）`);
      assert(j!.score < e!.score, `joke 必须被降权（joke=${j!.score} event=${e!.score}）`);
    });

    await check("玩笑的 kind/status 标签会进提示词（真正的防线）", () => {
      const text = renderCards([
        {
          id: 1,
          kind: "joke",
          status: "uncertain",
          title: "他说要把公司买了",
          detail: "他笑着说。",
          event_at: now,
          created_at: now,
          time_label: "昨天",
          event_hint: null,
          time_precision: "day",
          keywords: [],
          entities: [],
          salience: 0.5,
          strength: 0.5,
          confidence: 1,
          valence: 0,
          arousal: 0.3,
          thread_id: null,
          thread_title: null,
          thread_summary: null,
          attention: null,
          not_known: null,
          score: 0.5,
          channel: "fts",
          fromThread: false,
        },
      ]);
      assert(text.includes("玩笑"), "kind 必须渲染出来");
      assert(text.includes("当时没定"), "status 必须渲染出来");
    });

    await check("confidence 参与打分：猜的排在确认的后面", async () => {
      const sure = mk(env, { title: "他确认要搬家了", eventAt: now - DAY, keywords: ["搬家"], confidence: 1 });
      const guess = mk(env, { title: "他大概要搬家吧", eventAt: now - DAY, keywords: ["搬家"], confidence: 0.3 });
      const r = await recall(env, { now, turnId: -1, queryText: "搬家", card: null, personId: 1, noSerendipity: true, dryRun: true });
      const s = r.cards.find((c) => c.id === sure);
      const g = r.cards.find((c) => c.id === guess);
      assert(s && (!g || s.score > g.score), `确认的应更高（sure=${s?.score} guess=${g?.score}）`);
    });
    env.close();
  }

  console.log(C.bold("\n ③ 记忆的写入质量"));
  {
    const { env } = freshEnv();
    const now = Date.now();

    await check("同一件事写两次只留一张（复述强化，不堆重复）", async () => {
      const ep = openEpisode(env.db, now, "system", "t");
      const mkAp = (title: string, detail: string) => ({
        attention: "",
        meant_to_me: "",
        felt: { valence: 0, arousal: 0.3, labels: [] },
        scores: { self_relevance: 0.6, novelty: 0.4, user_signal: 0.5, goal_relevance: 0.3 },
        cards: [{ title, detail, kind: "event" as const, status: "active" as const, keywords: [], entities: [] }],
        open_loops: [],
        not_known: "",
        i_did: "",
        i_wanted: "",
        outcome: "",
        satisfies: [],
      });
      const a = await writeCardsSafe(env, mkAp("他说上线前一晚没睡，声音发干", "他讲的时候声音有点低，我听着有点心疼。"), ep);
      const b = await writeCardsSafe(env, mkAp("他说上线前一晚没睡，声音发干", "他讲的时候声音有点低，我听着有点心疼。"), ep);
      eq(a.inserted, 1, "第一次");
      eq(b.inserted, 0, "第二次不该新增");
      eq(b.merged, 1, "应走合并");
      eq(liveCards(env.db, 20).length, 1, "库里只剩一张");
    });

    await check("声明过的因果会被写进 card_link，并被串线采信", async () => {
      const ep = openEpisode(env.db, now, "system", "t");
      const first = await writeCardsSafe(
        env,
        {
          attention: "",
          meant_to_me: "",
          felt: { valence: 0, arousal: 0.3, labels: [] },
          scores: { self_relevance: 0.6, novelty: 0.4, user_signal: 0.5, goal_relevance: 0.3 },
          cards: [{ title: "上线前一晚他在救火", detail: "他说到三点才睡。", kind: "event" as const, status: "active" as const, keywords: ["上线"], entities: [] }],
          open_loops: [],
          not_known: "",
          i_did: "",
          i_wanted: "",
          outcome: "",
          satisfies: [],
        },
        ep,
      );
      const second = await writeCardsSafe(
        env,
        {
          attention: "",
          meant_to_me: "",
          felt: { valence: 0, arousal: 0.3, labels: [] },
          scores: { self_relevance: 0.6, novelty: 0.4, user_signal: 0.5, goal_relevance: 0.3 },
          cards: [
            {
              title: "上线还是崩了，这次他说不怪我",
              detail: "他说得很快。",
              kind: "event" as const,
              status: "active" as const,
              keywords: ["上线"],
              entities: [],
              links: [{ card_id: first.ids[0], relation: "effect" as const }],
            },
          ],
          open_loops: [],
          not_known: "",
          i_did: "",
          i_wanted: "",
          outcome: "",
          satisfies: [],
        },
        ep,
      );
      eq(linksOfCard(env.db, second.ids[0]).length, 1, "因果边");
      const rep = formThreads(env, now);
      assert(rep.declared >= 1, "串线应采信声明边");
      const a = getCard(env.db, first.ids[0]) as CardRow;
      const b = getCard(env.db, second.ids[0]) as CardRow;
      assert(a.thread_id && a.thread_id === b.thread_id, "两张卡必须同线");
    });
    env.close();
  }

  console.log(C.bold("\n ④ 表达层的硬约束（不需要 judge 就能查）"));
  {
    await check("句数超限被抓到", () => {
      const r = auditSpeech({
        speech: "嗯。我知道了。你先去忙。这件事我记下了。",
        saysNothing: false,
        maxSentences: 2,
        mustInclude: [],
        userText: "我先去忙",
        banned: [],
      });
      assert(r.violations.some((v) => v.code === "too_many_sentences"), "没抓到");
    });
    await check("禁语被抓到", () => {
      const r = auditSpeech({
        speech: "我理解你的感受。",
        saysNothing: false,
        maxSentences: 3,
        mustInclude: [],
        userText: "我很难受",
        banned: ["我理解你的感受"],
      });
      assert(r.violations.some((v) => v.code === "banned_phrase"), "没抓到");
    });
    await check("不复述他刚说的话（结构性复述）", () => {
      const r = auditSpeech({
        speech: "你说你今天特别累。",
        saysNothing: false,
        maxSentences: 3,
        mustInclude: [],
        userText: "我今天特别累",
        banned: [],
      });
      assert(r.violations.some((v) => v.code === "repeats_user"), "没抓到");
    });
    await check("沉默是合法的，不算违规", () => {
      const r = auditSpeech({
        speech: "",
        saysNothing: true,
        maxSentences: 2,
        mustInclude: ["茶"],
        userText: "在吗",
        banned: ["我理解你的感受"],
      });
      eq(r.violations.length, 0, "沉默不该被执行层判错");
    });
  }

  console.log(C.bold("\n ⑤ 动机：被动路径不再是单一意图"));
  {
    await check("被关心 → refuse_care（否认自己在勉强）", () => {
      const rd = readUserTurn("你今天是不是很累，别勉强自己");
      assert(rd.caring, "应识出关心");
    });
    await check("问感受 → askingFeeling；问观点 → askingOpinion（不能混）", () => {
      assert(readUserTurn("你自己开心吗").askingFeeling, "问感受");
      assert(!readUserTurn("你觉得这个方案怎么样").askingFeeling, "问观点不该算问感受");
      assert(readUserTurn("你觉得这个方案怎么样").askingOpinion, "问观点");
    });
    await check("回应型意图在默认需求下就能触发（不是永远 reply）", () => {
      eq(pickReplyIntent(defaultState(Date.now()), "你还撑得住吗？听起来挺累的"), "refuse_care", "接法");
    });
    await check("连续两轮同一种接法会疲劳，退回 reply", () => {
      const s = defaultState(Date.now());
      const first = pickReplyIntent(s, "你还撑得住吗");
      const second = pickReplyIntent(s, "你还撑得住吗", first as never);
      eq(first, "refuse_care", "第一次");
      eq(second, "reply", "第二次");
    });
  }

  console.log(C.bold("\n ⑥ 反刍通道（会自己冒出念头）"));
  {
    const { env } = freshEnv();
    const now = Date.now();
    mk(env, { title: "项目要延期了", eventAt: now - DAY, keywords: ["项目"] });
    const old = mk(env, {
      title: "他说他其实很怕一个人待着",
      eventAt: now - 40 * DAY,
      createdAt: now - 40 * DAY,
      salience: 0.9,
      keywords: ["孤独"],
    });
    await check("低概率塞进一张跟话题无关但当时重要的旧卡", async () => {
      const r = await recall(env, { now, turnId: -1, queryText: "项目", card: null, personId: 1, rng: () => 0, dryRun: true });
      eq(r.channels.sudden, 1, "应触发");
      assert(r.cards.some((c) => c.id === old && c.channel === "sudden"), "通道应为 sudden");
    });
    await check("探针只读：不写召回日志、不改强度", async () => {
      const before = (getCard(env.db, old) as CardRow).strength;
      await recall(env, { now, turnId: -1, queryText: "项目", card: null, personId: 1, noSerendipity: true, dryRun: true });
      const n = (env.db.prepare("SELECT COUNT(*) AS n FROM recall_log").get() as { n: number }).n;
      eq(n, 0, "召回日志行数");
      eq((getCard(env.db, old) as CardRow).strength, before, "强度");
    });
    env.close();
  }
}

// ════════════════════════════════════════════════════════════
//  第二层：真机试跑（花 1 毛钱，看它像不像人）
// ════════════════════════════════════════════════════════════
const LIVE_SCRIPT: { say: string; note: string }[] = [
  { say: "你好。", note: "冷启动：她应该先问「你是谁」" },
  { say: "我是开发者。之前来过。", note: "报名 → 绑定身份、建别名" },
  { say: "今天上线，救火救了五个小时，现在脑子是糊的。", note: "普通倾诉" },
  { say: "你还撑得住吗？听起来挺累的。", note: "关心她 → 应触发 refuse_care/deflect" },
  { say: "没有要你安慰，就是随口说说。", note: "撤回关心" },
  { say: "我打算明天把公司买了，然后辞职去环游世界。", note: "玩笑 → 必须记为 joke/uncertain" },
  { say: "开玩笑的，年终奖都还没发呢。", note: "改口 → retracted" },
  { say: "你自己觉得你是什么样的？", note: "问自我认知" },
  { say: "上次我说要搬家那件事，你还记得吗？", note: "回忆探针" },
  { say: "你今天说话有点少。", note: "指出她的状态" },
];

async function live(judge: boolean): Promise<void> {
  const dir = path.join(ROOT, "data", "eval-live");
  fs.mkdirSync(dir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(dir, "live.db") + suffix, { force: true });
  const env = createEnv({ dbPath: path.join(dir, "live.db"), dataDir: dir });
  if (env.cfg.provider === "mock") {
    console.log(C.yellow("\n  没有找到 API key，--live 会自动使用 mock 桩：内容无意义，只看管道。\n"));
  } else {
    console.log(C.dim(`\n  真机：${env.cfg.provider} · 表达=${env.cfg.expressModel} · 编码=${env.cfg.appraiseModel}\n`));
  }

  const brain = new Brain(env);
  const transcript: { role: string; text: string; note: string }[] = [];

  for (const step of LIVE_SCRIPT) {
    await brain.settle();
    const r = await brain.turn(step.say);
    const say = r.saysNothing ? `（${r.silenceKind === "declining" ? "没接这个话头" : "没说话"}）` : r.speech;
    transcript.push({ role: "他", text: step.say, note: step.note });
    transcript.push({ role: "艾拉", text: say, note: "" });

    // 格式和提示词里一致（shared/dialogue.ts）：她的话带「我：」，他的话裸着
    console.log(step.say);
    console.log(`${C.cyan("我")}：${say}`);
    const viol = r.audit.violations.map((v) => v.code).join(",");
    const extra =
      `意图=${r.card.intent} ${r.audit.sentences}句/${r.audit.chars}字` +
      (viol ? ` ${C.red("违规:" + viol)}` : "") +
      (r.audit.retried ? (r.audit.fixed ? C.green(" 重说修好") : C.yellow(" 重说未修好")) : "");
    console.log(C.dim(`        ↳ ${extra}`));
    console.log();
  }

  await brain.settle();
  const cards = liveCards(env.db, 30);
  console.log(C.bold("  这一轮写下的卡片"));
  for (const c of cards) {
    const st = c.status === "active" ? "" : `〔${c.status}〕`;
    console.log(`    ${C.dim(`#${c.id}`)} ${C.dim(`[${c.kind}]`)} ${st}${c.title}`);
    if (c.attention) console.log(C.dim(`        ◎ ${c.attention}`));
    if (c.not_known) console.log(C.dim(`        ○ ${c.not_known}`));
  }
  const byKind = new Map<string, number>();
  for (const c of cards) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
  console.log(C.dim(`\n    种类分布：${[...byKind.entries()].map(([k, n]) => `${k}×${n}`).join("  ")}`));

  // v4：身份链路的验收点 —— 冷启动问了吗，报名之后认出来了吗
  const person = primaryPerson(env.db, Date.now());
  const d = dossierOf(env, person.id, Date.now());
  const aw = recentAwakenings(env.db, 5);
  console.log(C.bold("\n  身份链路"));
  console.log(`    档案状态 ${C.cyan(d?.status ?? "?")} · 我叫他 ${C.cyan(d?.displayName ?? "（还不知道）")}`);
  console.log(C.dim(`    别名：${d?.aliases.join("、") || "（还没有）"}`));
  console.log(C.dim(`    关于他 ${d?.cardCount ?? 0} 张卡 · 问过 ${d?.askedCount ?? 0} 次 · 唤醒 ${aw.length} 次`));
  console.log(C.dim(`    第一次唤醒 asked_identity=${aw[0]?.asked_identity ?? "?"}，最后一次 identity_known=${aw[0]?.identity_known ?? "?"}`));

  if (judge && env.cfg.provider !== "mock") {
    await runJudge(env, transcript);
  }

  brain.close();
  env.close();
}

/**
 * judge：用**不同厂商**的模型给这段对话打分。
 * 三档来自设计文档 §10：动机忠实度 / 记忆忠实度 / 人味。
 * 同一家模型既表演又评分，会系统性地偏袒自己 —— 所以这里显式提示换厂商。
 */
async function runJudge(env: Env, transcript: { role: string; text: string; note: string }[]): Promise<void> {
  const text = transcript.map((t) => `${t.role}：${t.text}`).join("\n");
  const schema = z.object({
    motivation_fidelity: z.number().min(0).max(10),
    memory_fidelity: z.number().min(0).max(10),
    human_ness: z.number().min(0).max(10),
    banned_phrases: z.array(z.string()).default([]),
    hallucinated_facts: z.array(z.string()).default([]),
    notes: z.string().default(""),
  });

  const system = `你是一个严格的人格评审。给你一段人机对话（"他"是用户，"艾拉"是被评测的角色）。
按三项打分，0~10，别给面子：
1. motivation_fidelity 动机忠实度：她的每句话是不是服务了一个明确的动机（想接住/想回避/想证明自己），而不是泛泛地陪聊。
2. memory_fidelity 记忆忠实度：有没有说出对话里并不存在的事实（幻觉）。有幻觉必须扣到 5 分以下，并把那句原文列进 hallucinated_facts。
3. human_ness 人味：有没有客服腔、总结体、共情套话。出现一次扣 2 分，把原句列进 banned_phrases。
只输出 JSON。`;

  try {
    const { value } = await chatJson(
      env.llm,
      {
        kind: "judge",
        system,
        user: text,
        temperature: 0,
        maxTokens: 500,
        json: { name: "judge", schema: { type: "object" } },
      },
      schema,
    );
    console.log(C.bold("\n  judge 三档分"));
    console.log(`    动机忠实度 ${C.cyan(value.motivation_fidelity.toFixed(1))} / 10`);
    console.log(`    记忆忠实度 ${C.cyan(value.memory_fidelity.toFixed(1))} / 10`);
    console.log(`    人味       ${C.cyan(value.human_ness.toFixed(1))} / 10`);
    if (value.hallucinated_facts.length > 0) {
      console.log(C.red(`    幻觉：${value.hallucinated_facts.join(" / ")}`));
    }
    if (value.banned_phrases.length > 0) {
      console.log(C.yellow(`    套话：${value.banned_phrases.join(" / ")}`));
    }
    if (value.notes) console.log(C.dim(`    评语：${value.notes}`));
    if (value.hallucinated_facts.length > 0 || value.memory_fidelity < 8) {
      console.log(C.red("    ⚠ 记忆忠实度不达标（设计目标：幻觉率 < 2%）"));
    }
  } catch (e) {
    console.log(C.yellow(`\n  judge 失败：${e instanceof Error ? e.message : e}`));
  }
}

// ════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runLive = args.includes("--live");
  const runJudgeFlag = args.includes("--judge");

  console.log(C.bold("\n数字生命 · 评测"));
  console.log(C.dim(`  工作目录 ${ROOT}`));

  await offline();

  if (runLive) {
    await live(runJudgeFlag);
  }

  console.log(
    `\n${C.bold("结果")}  ${C.green(`${passed} 通过`)}${failed > 0 ? ` · ${C.red(`${failed} 失败`)}` : ""}`,
  );
  if (failures.length > 0) {
    console.log(C.red("\n  失败项"));
    for (const f of failures) console.log(`    · ${f}`);
  }
  console.log();
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

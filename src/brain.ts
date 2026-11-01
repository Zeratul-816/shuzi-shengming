/**
 * 编排层：一轮对话的完整流水线。全项目唯一"知道所有模块"的地方。
 *
 * ── turn() 的时序 ─────────────────────────────────────────
 *   ① ensureEpisode()      距上次说话超过 30min 就另起一段 episode
 *   ② readUserTurn()       纯规则读他这句话在干什么（0 成本）
 *   ③ 认人               他这句话说明了自己是谁吗（同步、纯规则）
 *   ④ tick(pendingReply)   取被动回复用的动机卡（顺带推进一拍需求/情绪）
 *   ⑤ recentTraces(8)      取"本轮之前"的对话快照 —— 给 appraise 用
 *   ⑥ recall()             结构化召回：时间窗/关键词/情绪/人物/未了/种子/反刍
 *   ⑦ express()            强模型说话；内部会做确定性校验，必要时重说一次
 *   ⑧ addTrace × 2         本轮两条流水落库，**同时拿到 trace id**
 *   ⑨ 情绪与需求回写 + 审计落库
 *   ⑩ 返回结果 → 用户此刻已经看到回复
 *   ⑪ enqueue(postProcess) 后台：编码成卡片 + 因果链 + 关系升温
 *
 * ── 为什么 ⑧ 的 id 很重要 ─────────────────────────────────
 *   卡片要记住自己是从哪一段原始记录提炼出来的（trace_from / trace_to）。
 *   这就是"两段式回忆"的第二段能翻到原话的唯一依据。所以 trace 必须先写、
 *   拿到 id 之后再交给写卡片的流程。
 *
 * ── 为什么后台任务用串行队列 ──────────────────────────────
 *   同一个 DB 连接，写卡片时还要做"查最近 200 张 → 比对判重 → 插入 + 写因果"，
 *   并发跑会互相踩。settle() 就是等这条链跑空，测试和退出前必须调。
 *
 * ── v3 新增的两处"启动即维护"────────────────────────────
 *   applyDecay（会淡）+ refreshStatuses（会过期）。两者都是低频、非实时、
 *   但**必须一定会发生**的事。放在构造里，保证每次启动都会做一次。
 */
import type { Env } from "./env.ts";
import type {
  ExpressOutput,
  MotivationCard,
  RetrievedCard,
  TraceSlice,
  UserRead,
} from "./shared/types.ts";
import { readUserTurn } from "./motivation/reader.ts";
import type { CardRow, PersonRow, TraceRow } from "./store/repos.ts";
import { all } from "./store/db.ts";
import {
  activeSelfSheet,
  addTrace,
  applyDecay,
  awakeningCount,
  bumpOpenLoop,
  closeEpisode,
  getCards,
  getPerson,
  lastUserTraceTs,
  latestEpisode,
  listOpenLoops,
  liveCardCount,
  logAwakening,
  logExpressAudit,
  openEpisode,
  primaryPerson,
  recentTraces,
  touchPerson,
  updateAwakening,
  updatePerson,
} from "./store/repos.ts";
import { loadState, nudgeAffect, satisfy, saveState } from "./motivation/state.ts";
import type { MotivationState } from "./shared/types.ts";
import { tick, buildReplyCard } from "./motivation/tick.ts";
import { recall } from "./memory/retrieve.ts";
import { appraise } from "./memory/appraise.ts";
import { writeCards } from "./memory/cards.ts";
import { refreshStatuses } from "./memory/status.ts";
import {
  applyPeopleMentions,
  applySpeakerDraft,
  dossierOf,
  extractCalledAs,
  noteAsked,
  refreshDossier,
  resolveIdentityFromText,
  shouldAskIdentity,
} from "./memory/person.ts";
import { express } from "./express/express.ts";
import type { AssembledPrompt } from "./express/assemble.ts";
import { seedPersona } from "./express/persona.ts";

export interface TurnResult {
  kind: "reply" | "proactive";
  speech: string;
  saysNothing: boolean;
  /** 沉默的语义：不想说 / 听见了不接 */
  silenceKind: string | null;
  out: ExpressOutput;
  card: MotivationCard;
  recalled: RetrievedCard[];
  prompt: AssembledPrompt;
  latencyMs: number;
  /** 是否翻过原始记录（两段式回忆的第二段） */
  expanded: boolean;
  details: TraceSlice[];
  channels: Record<string, number>;
  /** 确定性校验的结果（句数/禁语/复述） */
  audit: {
    violations: { code: string; detail: string }[];
    sentences: number;
    chars: number;
    repeatRatio: number;
    retried: boolean;
    fixed: boolean;
    bannedHits: string[];
  };
  /** 表情滞后之后的对外情绪 */
  displayEmotion: { valence: number; arousal: number; label: string; intensity: number };
  /** 他这句话被规则读成了什么（调试用） */
  read: UserRead;
}

export interface TurnStats {
  cards: number;
  episodeId: number;
  state: MotivationState;
  lastRejected: { intent: string; score: number; reason: string }[];
  lastRead: UserRead | null;
}

export class Brain {
  readonly env: Env;
  private state: MotivationState;
  private episodeId = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private turnId = 0;
  private cardsPerTurn: number[] = [];
  private lastRejected: { intent: string; score: number; reason: string }[] = [];
  private lastRead: UserRead | null = null;
  lastTurn: TurnResult | null = null;

  // ── v4：身份 ────────────────────────────────────────────
  /** 这一次苏醒的事件 id */
  private awakeningId = 0;
  /** 这一轮认定的谈话对象（null = 还没认出来） */
  private personId: number | null = null;
  /** 这一次苏醒里我已经知道是谁了吗 */
  private identityKnown = false;
  /** 这一次苏醒里我问过"你是谁"了吗（同一次苏醒只问一次） */
  private askedThisAwakening = false;

  constructor(env: Env) {
    this.env = env;
    const now = Date.now();
    seedPersona(env.db, now);
    this.state = loadState(env.db, now);
    this.ensureEpisode(now);

    // v4：每一次唤醒都是一个事件。醒来的那一刻**谈话对象是待定的**，
    // 所以 identity_known 写 0 —— 这不是失忆，是她真的看不见对面是谁。
    const first = awakeningCount(env.db) === 0;
    this.awakeningId = logAwakening(env.db, {
      at: now,
      mode: first ? "cold_start" : "resume",
      episodeId: this.episodeId,
    });

    applyDecay(env.db, now);
    // 时间驱动的状态迁移：一张"下周三出差"的计划卡，过了那周就该自己失效。
    // 这是 v2 最原始的病灶（把已失效的事当现状）在机制层唯一的解。
    const st = refreshStatuses(env, now);
    if (st.expired > 0) {
      console.log(`[brain] ${st.expired} 张卡片按时间自动失效（${st.transitions.map((t) => t.reason).join("、")}）`);
    }
  }

  /** 当前认定的谈话对象；还没认出来就用主档案（一张空档案） */
  private currentPerson(now: number) {
    const bound = this.personId !== null ? getPerson(this.env.db, this.personId) : undefined;
    return bound ?? primaryPerson(this.env.db, now);
  }

  /** 这一刻该不该问"你是谁" */
  private identityState(person: { id: number }) {
    const shouldAsk = shouldAskIdentity(this.env, person.id, { askedThisAwakening: this.askedThisAwakening });
    return { shouldAsk, known: this.identityKnown, askedCount: 0 };
  }

  private ensureEpisode(now: number): void {
    const last = latestEpisode(this.env.db);
    // 首轮还没有 trace 时用 episode 起始时刻代替"上次说话时间"，
    // 否则 (now - 0) 会被当成很久没说话，每次启动都多开一段。
    const lastActivity = lastUserTraceTs(this.env.db) ?? last?.started_at ?? 0;
    const gap = this.env.cfg.resumeGapMs;
    if (last && last.ended_at === null && now - lastActivity <= gap) {
      this.episodeId = last.id;
      return;
    }
    if (last && last.ended_at === null) {
      closeEpisode(this.env.db, last.id, now, this.state.affect.v);
    }
    this.episodeId = openEpisode(this.env.db, now, "system", "一次相处");
  }

  private idleMs(now: number): number {
    const lastUser = lastUserTraceTs(this.env.db);
    return lastUser ? now - lastUser : Number.MAX_SAFE_INTEGER;
  }

  private starved(): boolean {
    const recent = this.cardsPerTurn.slice(-6);
    if (recent.length < 3) return false;
    return recent.reduce((a, b) => a + b, 0) / recent.length < 0.8;
  }

  private enqueue(fn: () => Promise<unknown>): void {
    this.queue = this.queue.then(fn).catch((e) => {
      console.warn("[brain] 后台任务失败：", e instanceof Error ? e.message : e);
    });
  }

  /** 用户在说话：被动回应路径 */
  async turn(text: string): Promise<TurnResult> {
    const { env } = this;
    const now = Date.now();
    this.ensureEpisode(now);

    const personBefore = this.currentPerson(now);
    // ── v4：先认人，再决定怎么接 ──
    // 这一步必须**同步、纯规则**。如果放到后台的编码器里做，
    // 就会出现"他刚报完名，她下一轮还在问你是谁"——这是最刺眼的一种错。
    if (!this.identityKnown) {
      const resolved = resolveIdentityFromText(env, text, now);
      if (resolved) {
        this.identityKnown = true;
        this.personId = resolved.personId;
        updateAwakening(env.db, this.awakeningId, {
          personId: resolved.personId,
          identityKnown: true,
        });
      }
    }
    const person = this.currentPerson(now);
    touchPerson(env.db, person.id, now);
    // 他这次叫我什么 —— 记在唤醒事件上（这是"她也在被确认"的那一半）
    const called = extractCalledAs(env, text);
    if (called) updateAwakening(env.db, this.awakeningId, { calledAs: called });

    const loops = listOpenLoops(env.db, 5);
    const read = readUserTurn(text);
    this.lastRead = read;
    const turnId = ++this.turnId;

    const t = tick(env.db, this.state, {
      now,
      userIdleMs: this.idleMs(now),
      starvedForNovelty: this.starved(),
      openLoops: loops,
      pendingReply: true,
      read,
      identity: this.identityState(person),
    });
    this.state = t.state;
    this.lastRejected = t.rejected;
    const card = t.card!;

    const recent = recentTraces(env.db, this.episodeId, 8);
    const recalled = await recall(env, {
      now,
      turnId,
      queryText: text,
      card,
      personId: person.id,
      affect: { v: this.state.affect.v, a: this.state.affect.a },
    });
    const self = activeSelfSheet(env.db);

    // 先把用户这句话落库，再调表达层。
    // 原顺序（express 之后才写）有两个毛病：
    //   1. 表达层抛错时，他刚说的话会整轮消失 —— 不进历史，下次也召回不到；
    //   2. 表达层拿不到本轮输入（recent 是"本轮之前"的快照），于是只能回上一轮的话。
    const userTraceId = addTrace(env.db, { episodeId: this.episodeId, ts: now, role: "user", content: text });

    const ex = await express(env, {
      now,
      person,
      dossier: dossierOf(env, person.id, now),
      self,
      card,
      cards: recalled.cards,
      recent,
      loops,
      currentUtterance: text,
      read,
    });

    const meTraceId = addTrace(env.db, {
      episodeId: this.episodeId,
      ts: now + 1,
      role: "me",
      content: ex.out.says_nothing ? "（没说话）" : ex.out.speech,
      meta: {
        card,
        recalled: recalled.cards.map((c) => c.id),
        expanded: ex.expanded,
        intent: card.intent,
        violations: ex.audit.violations.map((v) => v.code),
      },
    });

    this.afterExpress(now, turnId, "reply", card, ex, recalled.cards);

    // 她这一轮问的是"你是谁" → 记账。**每次苏醒只问一次**，
    // 累计三次他都不说就不再问了（MAX_ASKS）。
    if (card.intent === "ask_identity") {
      noteAsked(env, person.id, now);
      this.askedThisAwakening = true;
      updateAwakening(env.db, this.awakeningId, { askedIdentity: true });
    }

    this.enqueue(() =>
      this.postProcess({
        now,
        card,
        person,
        userText: text,
        assistantText: ex.out.speech,
        transcript: recent,
        recalled: recalled.cards,
        traceFrom: userTraceId,
        traceTo: meTraceId,
      }),
    );

    const result: TurnResult = {
      kind: "reply",
      speech: ex.out.speech,
      saysNothing: ex.out.says_nothing,
      silenceKind: ex.out.says_nothing ? ex.out.silence_kind : null,
      out: ex.out,
      card,
      recalled: recalled.cards,
      prompt: ex.prompt,
      latencyMs: ex.totalLatencyMs,
      expanded: ex.expanded,
      details: ex.details,
      channels: recalled.channels,
      audit: {
        violations: ex.audit.violations,
        sentences: ex.audit.metrics.sentences,
        chars: ex.audit.metrics.chars,
        repeatRatio: ex.audit.metrics.repeatRatio,
        retried: ex.retried,
        fixed: ex.fixed,
        bannedHits: ex.audit.bannedHits,
      },
      displayEmotion: ex.displayEmotion,
      read,
    };
    this.lastTurn = result;
    return result;
  }

  /** 主动发言：由定时器驱动，返回 null 表示这一刻选择沉默 */
  async proactive(): Promise<TurnResult | null> {
    const { env } = this;
    const now = Date.now();
    this.ensureEpisode(now);
    const person = this.currentPerson(now);
    const loops = listOpenLoops(env.db, 5);
    const read = readUserTurn("");
    this.lastRead = read;

    const t = tick(env.db, this.state, {
      now,
      userIdleMs: this.idleMs(now),
      starvedForNovelty: this.starved(),
      openLoops: loops,
      pendingReply: false,
      read,
      // 主动发言不问身份 —— 这条通路不是回应型意图
      identity: { shouldAsk: false, known: this.identityKnown, askedCount: 0 },
    });
    this.state = t.state;
    this.lastRejected = t.rejected;
    if (!t.card) return null;
    const card = t.card;
    const turnId = ++this.turnId;

    const recent = recentTraces(env.db, this.episodeId, 8);
    const recalled = await recall(env, {
      now,
      turnId,
      queryText: `${card.why} ${card.desired_outcome}`,
      card,
      personId: person.id,
      affect: { v: this.state.affect.v, a: this.state.affect.a },
    });
    const self = activeSelfSheet(env.db);
    const ex = await express(env, {
      now,
      person,
      dossier: dossierOf(env, person.id, now),
      self,
      card,
      cards: recalled.cards,
      recent,
      loops,
      currentUtterance: "", // 主动发言：他没说话，是自己想开口
      read,
    });

    const meTraceId = addTrace(env.db, {
      episodeId: this.episodeId,
      ts: now,
      role: "me",
      content: ex.out.says_nothing ? "（没说话）" : ex.out.speech,
      meta: {
        proactive: true,
        card,
        recalled: recalled.cards.map((c) => c.id),
        violations: ex.audit.violations.map((v) => v.code),
      },
    });

    // 加注：persuade / follow_up / ask_help 都是"同一件事的再一次"，
    // 必须记下来，否则下一拍会端出一模一样的筹码。
    if (["follow_up", "persuade", "ask_help"].includes(card.intent) && loops[0]) {
      bumpOpenLoop(env.db, loops[0].id, card.must_include[0] ?? null);
    }

    this.afterExpress(now, turnId, "proactive", card, ex, recalled.cards);

    this.enqueue(() =>
      this.postProcess({
        now,
        card,
        person,
        userText: "",
        assistantText: ex.out.speech,
        transcript: recent,
        recalled: recalled.cards,
        traceFrom: meTraceId,
        traceTo: meTraceId,
      }),
    );

    const result: TurnResult = {
      kind: "proactive",
      speech: ex.out.speech,
      saysNothing: ex.out.says_nothing,
      silenceKind: ex.out.says_nothing ? ex.out.silence_kind : null,
      out: ex.out,
      card,
      recalled: recalled.cards,
      prompt: ex.prompt,
      latencyMs: ex.totalLatencyMs,
      expanded: ex.expanded,
      details: ex.details,
      channels: recalled.channels,
      audit: {
        violations: ex.audit.violations,
        sentences: ex.audit.metrics.sentences,
        chars: ex.audit.metrics.chars,
        repeatRatio: ex.audit.metrics.repeatRatio,
        retried: ex.retried,
        fixed: ex.fixed,
        bannedHits: ex.audit.bannedHits,
      },
      displayEmotion: ex.displayEmotion,
      read,
    };
    this.lastTurn = result;
    return result;
  }

  /**
   * 表达之后的记账（turn 和 proactive 共用）。
   *
   * 五件事：
   *   1. 需求与情绪回写 —— 但**沉默分两种**：听见了不接的沉默不该扣联结
   *   2. 审计落库（句数/禁语/复述/违规）—— 这是"约束遵守率"的唯一数据源
   *   3. 关键袒露用掉了就上锁
   *   4. 翻过原话的卡片在召回日志里标出来（v2 这一列恒为 0）
   *   5. breaks_motivation 落库 —— 模型说"这个动机我演不出来"是有价值的一票
   */
  private afterExpress(
    now: number,
    turnId: number,
    kind: "reply" | "proactive",
    card: MotivationCard,
    ex: Awaited<ReturnType<typeof express>>,
    recalled: RetrievedCard[],
  ): void {
    const { env } = this;

    nudgeAffect(this.state, ex.out.emotion.valence, ex.out.emotion.arousal);
    // 沉默的语义：她说"不想说"时，联结需求确实没被满足；
    // 但"听见了、选择不接"（deflect 型沉默）也是一种回应，不该罚。
    const ignored = ex.out.says_nothing && ex.out.silence_kind === "not_now";
    if (!ignored) satisfy(this.state, "connection", 1);
    saveState(env.db, this.state);

    logExpressAudit(env.db, {
      ts: now,
      turnId,
      kind,
      intent: card.intent,
      sentences: ex.audit.metrics.sentences,
      chars: ex.audit.metrics.chars,
      maxSentences: card.max_sentences,
      repeatRatio: ex.audit.metrics.repeatRatio,
      bannedHits: ex.audit.bannedHits,
      violations: ex.audit.violations,
      retried: ex.retried,
      fixed: ex.fixed,
      saysNothing: ex.out.says_nothing,
      silenceKind: ex.out.says_nothing ? ex.out.silence_kind : null,
      breaksMotivation: ex.out.breaks_motivation,
    });

    if (ex.expanded && ex.details.length > 0) {
      const ids = ex.details.map((d) => d.cardId);
      const marks = ids.map(() => "?").join(",");
      env.db
        .prepare(`UPDATE recall_log SET expanded = 1 WHERE turn_id = ? AND card_id IN (${marks})`)
        .run(turnId, ...ids);
    }
  }

  /** 主观编码 → 写卡片 + 因果链 → 关系升温。永远在后台串行跑。 */
  private async postProcess(p: {
    now: number;
    card: MotivationCard;
    person: PersonRow;
    userText: string;
    assistantText: string;
    transcript: TraceRow[];
    recalled: RetrievedCard[];
    traceFrom: number;
    traceTo: number;
  }): Promise<void> {
    const { env } = this;

    // 告诉编码器"你已经记过什么"：本轮召回 ∪ 本段最近写下的。
    // 只给召回的那几张不够——同一件事常在不同轮次被重新观察一遍，
    // 而那一轮未必召回得到上一次写的那张，于是又写一张新的。
    const recalledRows = getCards(
      env.db,
      p.recalled.map((c) => c.id),
    );
    const sameEpisode = all<CardRow>(
      env.db,
      `SELECT * FROM card
        WHERE episode_id = ? AND superseded_by IS NULL
        ORDER BY id DESC LIMIT 8`,
      [this.episodeId],
    );
    const knownById = new Map<number, CardRow>();
    for (const r of [...recalledRows, ...sameEpisode]) knownById.set(r.id, r);
    const knownCards = [...knownById.values()].sort((a, b) => b.id - a.id).slice(0, 10);

    const { appraisal } = await appraise(env, {
      userText: p.userText,
      assistantText: p.assistantText,
      transcript: p.transcript
        .filter((t) => t.role === "user" || t.role === "me")
        .map((t) => ({ role: t.role as "user" | "me", content: t.content, ts: t.ts })),
      card: p.card,
      person: p.person,
      knownCards,
      now: p.now,
    });

    // ── v4：身份归档 ──
    // 编码器是身份的**第二通道**：规则没抓住的长句自我介绍，由它补。
    // 它晚一轮生效，这是可以接受的（规则那条才是主通路）。
    const peopleMap = applyPeopleMentions(env, appraisal.people, p.now);
    applySpeakerDraft(env, appraisal.speaker, p.now, null);
    if (appraisal.speaker.label && !this.identityKnown) {
      this.identityKnown = true;
      this.personId = primaryPerson(env.db, p.now).id;
      updateAwakening(env.db, this.awakeningId, { personId: this.personId, identityKnown: true });
    }

    const result = await writeCards(env, appraisal, {
      now: p.now,
      episodeId: this.episodeId,
      personId: p.person.id,
      peopleMap,
      traceFrom: p.traceFrom,
      traceTo: p.traceTo,
    });

    // v4：把这一轮动过的档案重新聚合一次（便宜：几条 SQL）。
    for (const pid of result.peopleTouched) refreshDossier(env, pid, p.now);
    if (!result.peopleTouched.includes(p.person.id)) refreshDossier(env, p.person.id, p.now);

    for (const need of appraisal.satisfies) satisfy(this.state, need, 1);
    nudgeAffect(this.state, appraisal.felt.valence * 0.3, appraisal.felt.arousal * 0.2);
    saveState(env.db, this.state);

    // 关系：亲近感随互动缓慢上升；被伤到的时候才下降（现在还没有负向事件源，
    // 留一个 -0.02 的口子给后续的"被否定"信号）。
    updatePerson(env.db, p.person.id, { closeness: Math.min(1, p.person.closeness + 0.004) }, p.now);

    this.cardsPerTurn.push(result.inserted);
    if (this.cardsPerTurn.length > 20) this.cardsPerTurn.shift();
  }

  /** 等所有后台任务落地（退出、调试、测试前调用） */
  async settle(): Promise<void> {
    await this.queue;
    this.queue = Promise.resolve();
  }

  stats(): TurnStats {
    return {
      cards: liveCardCount(this.env.db),
      episodeId: this.episodeId,
      state: this.state,
      lastRejected: this.lastRejected,
      lastRead: this.lastRead,
    };
  }

  /** 退出时把这一段落款（v2 只在超时才关，正常退出会留一个 ended_at=NULL 的段） */
  close(): void {
    closeEpisode(this.env.db, this.episodeId, Date.now(), this.state.affect.v);
  }

  /**
   * 调试：手动按结构化条件回忆。
   * v3 起默认**只读**（dryRun）并关掉反刍通道 —— 调试工具不该有随机性，
   * 更不该写 recall_log、提升卡片强度，否则你观察的对象会被观察行为改变。
   */
  async recallProbe(query: string, now = Date.now(), opts: { dryRun?: boolean } = {}): Promise<RetrievedCard[]> {
    const r = await recall(this.env, {
      now,
      turnId: -1,
      queryText: query,
      card: null,
      personId: null,
      affect: { v: this.state.affect.v, a: this.state.affect.a },
      noSerendipity: true,
      dryRun: opts.dryRun ?? true,
    });
    return r.cards;
  }
}

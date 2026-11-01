/**
 * 全系统的类型契约 —— 同时是各字段的说明书。
 *
 * v2 的关键变化：**没有向量了**。
 * 记忆的基本单位从「原子」改成「卡片」：一张卡片 = 一条自足的事实/事件，
 * 带时间、状态、关键词、人物，以及指回原始记录的指针。
 * 检索靠这些结构化字段，不靠语义相似度 —— 理由见 db/schema.sql 顶部。
 *
 * v3 的关键变化：**把断掉的线接上**。
 *   · attention / meant_to_me 以前每轮生成、每轮丢弃，现在落到卡片上并进提示词；
 *   · 卡片之间可以**声明因果**（links），串线不再只靠关键词撞运气；
 *   · 沉默分两种（says_nothing + silence_kind）：「不想说」和「听见了但不接」；
 *   · 目标写在配置文件里，不写死在提示词里。
 *
 * 三条约定照旧：
 *   1. 跨模块的形状只在这里定义一次；
 *   2. 凡是从 LLM 手里接过来的结构都用 zod 校验；
 *   3. 每个字段都标了「谁写、谁读、改了会影响什么」。
 *
 * 数据链路：
 *   用户说话 → MotivationCard（纯规则）→ 按 时间/人物/关键词/情绪 检索卡片
 *   → 卡片骨架 + 来龙去脉进提示词 → LLM 说话（再过一遍确定性校验）
 *   → 异步：appraiser 产出 Appraisal.cards + links → 写进 card / card_link 表
 */
import { z } from "zod";

// ── 需求（动机引擎的稳态变量）────────────────────────────────
export const NEEDS = [
  "connection",
  "curiosity",
  "expression",
  "competence",
  "autonomy",
  "rest",
] as const;
export type Need = (typeof NEEDS)[number];
export const NeedSchema = z.enum(NEEDS);

// ── 卡片 ────────────────────────────────────────────────────
/** 讲"这是什么" */
export const CARD_KINDS = ["event", "fact", "preference", "relation", "self", "plan", "joke"] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export const CardKindSchema = z.enum(CARD_KINDS);

/**
 * 讲"现在还成立吗"。这一列是整套设计里最重要的一列：
 * 没有它，三周前的玩笑会和昨天的陈述在库里平起平坐，
 * 被回忆起来时就会变成"既成事实"。
 *
 * v3 起它有两个写入者：
 *   · appraiser（编码时判断）—— memory/appraise.ts
 *   · refreshStatuses（时间到了自动过期）—— memory/status.ts
 * 后者是必需的：一张"下周三出差"的计划卡，如果没有时间驱动的迁移，
 * 那一周过去之后它仍然是一个 active 的计划，永远不会自己失效。
 */
export const CARD_STATUS = ["active", "expired", "retracted", "uncertain"] as const;
export type CardStatus = (typeof CARD_STATUS)[number];
export const CardStatusSchema = z.enum(CARD_STATUS);

/** 时间有多准。检索时按它决定要不要放宽时间窗 */
export const TIME_PRECISIONS = ["exact", "day", "week", "month", "vague"] as const;
export type TimePrecision = (typeof TIME_PRECISIONS)[number];
export const TimePrecisionSchema = z.enum(TIME_PRECISIONS);

export const FeltSchema = z.object({
  valence: z.number().min(-1).max(1),
  arousal: z.number().min(0).max(1),
  labels: z.array(z.string()).max(4).default([]),
});
export type Felt = z.infer<typeof FeltSchema>;

/**
 * 卡片之间的**声明式**关系。串线的第一依据（猜的其次）。
 * 为什么必须显式声明：v2 的 thread 是事后用"共享词元 + 时间接近"猜出来的，
 * 串错和漏串都不会报错，只表现为"它的记忆有点乱"。
 */
export const LINK_RELATIONS = ["cause", "effect", "contradicts", "follows", "about"] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];
export const LinkRelationSchema = z.enum(LINK_RELATIONS);

export const LinkDraftSchema = z.object({
  card_id: z.number().int().describe("已知卡片的编号（提示词里以 #12 形式给出）"),
  relation: LinkRelationSchema.describe(
    "cause=因为那张/effect=导致那张/contradicts=和那张矛盾/follows=同一件事的后续/about=关于那张",
  ),
});
export type LinkDraft = z.infer<typeof LinkDraftSchema>;

/**
 * 一张待落库的卡片。前三项（title/detail/status）决定检索质量与真实性，
 * 后面几项决定它能不能被"按时间/人物/关键词"找回来。
 */
export const CardDraftSchema = z.object({
  title: z
    .string()
    .min(4)
    .max(60)
    .describe("一行摘要，检索列表里就显示这个。写具体的事，不要写'聊了聊近况'"),
  detail: z
    .string()
    .min(6)
    .max(300)
    .describe("2~4 句第一人称细节：他怎么说的、我怎么想、我当时不懂什么"),
  kind: CardKindSchema.default("event"),
  status: CardStatusSchema.default("active").describe("现在还成立吗；玩笑填 joke 类"),
  event_hint: z.string().max(24).optional().describe("原话里的时间词，如「上周三晚上」「刚才」"),
  event_at_iso: z
    .string()
    .max(40)
    .optional()
    .describe("尽力给出绝对时间：2026-02-10 或 2026-02-10T21:30。给不出就留空"),
  time_precision: TimePrecisionSchema.optional(),
  keywords: z
    .array(z.string().max(12))
    .max(8)
    .default([])
    .describe("以后可能用来搜这件事的词：项目名、物件、活动、情绪"),
  entities: z.array(z.string().max(12)).max(6).default([]).describe("人名/公司/产品/宠物等专有名词"),
  valid_until_hint: z.string().max(24).optional().describe("如果这条会过期，给个时间词"),
  salience: z.number().min(0).max(1).optional(),
  /** 这张卡片当时有多确定（0..1）。默认 1 = 我确信。
   * 它的用途不是好看：低 confidence 的卡片在检索里会被扣分，
   * 这样"我以为他下周要搬家"和"他确认下周要搬家"就不会同权。*/
  confidence: z.number().min(0).max(1).optional(),
  /** 这张卡片和已有卡片的关系。指不到具体哪张就留空，别编编号。 */
  links: z.array(LinkDraftSchema).max(4).default([]),
  /**
   * 这张卡是**关于谁**的。
   * 留空 = 关于他（正在跟我说话的人，默认）。
   * 填名字 = 关于另一个人（"老王说他儿子考上大学"→ about: "老王"）。
   * 它是"把信息归到人物卡片里"的入口：写入时按别名解析成 person_id。
   */
  about: z.string().max(16).optional(),
});
export type CardDraft = z.infer<typeof CardDraftSchema>;

export const OpenLoopDraftSchema = z.object({
  text: z.string().min(3).max(80).describe("我打算做但还没做的一件事"),
  due_hint: z.string().max(16).optional(),
  urgency: z.number().min(0).max(1).optional(),
});
export type OpenLoopDraft = z.infer<typeof OpenLoopDraftSchema>;

// ── 身份（v4）──────────────────────────────────────────────
export const DOSSIER_STATUS = ["unknown", "provisional", "known"] as const;
export type DossierStatus = (typeof DOSSIER_STATUS)[number];

/**
 * 这一轮**他**的身份线索。注意：只写他，永远不写我。
 *
 * 为什么身份要单独一个字段，而不是从 entities 里猜：
 *   entities 是"专有名词"，里面混着「公司」「报错」，还有她自己的名字。
 *   拿它当人物来源，第一张档案就是给她自己建的。
 *   所以身份走两条受控通道：
 *     · speaker —— 正在跟我说话的这个人在这一轮报了什么名
 *     · people  —— 这一轮提到的**其他**人
 *   其余实体一律只当检索词。
 */
export const SpeakerDraftSchema = z.object({
  /** 他这一轮说的自称/称呼。没提就留空 */
  label: z.string().max(16).default(""),
  /** true = 这是他自报的名字（"我是X""叫我X"），不是我从上下文猜的 */
  introduced: z.boolean().default(false),
});
export type SpeakerDraft = z.infer<typeof SpeakerDraftSchema>;

export const PersonMentionSchema = z.object({
  name: z.string().min(1).max(16).describe("出现的人名/称呼"),
  relation: z.string().max(12).default("").describe("他是我什么人：同事/家人/朋友，不知道就留空"),
});
export type PersonMention = z.infer<typeof PersonMentionSchema>;

/** 一个人物档案的运行期视图（给提示词和 /who 用） */
export interface PersonDossier {
  id: number;
  /** 内部主键式称呼 */
  name: string;
  /** 我现在怎么叫他（可能是临时的） */
  displayName: string | null;
  status: DossierStatus;
  aliases: string[];
  closeness: number;
  trust: number;
  warmth: number;
  /** 我对他确定/半确定的几条，来自卡片 */
  traits: { trait: string; confidence: number; cardId: number | null }[];
  /** 我还没弄清的问题 */
  openQuestions: string[];
  cardCount: number;
  /** 我问过几次「你是谁」 */
  askedCount: number;
  lastSeenAt: number | null;
}

/**
 * 一次"我经历了什么"的完整记录。字段去向（v3 起全部有归宿，旧版有一半被丢弃）：
 *   attention    → card.attention（我当时注意到哪一部分）
 *   meant_to_me  → card.meant_to_me（这件事对我意味着什么）
 *   felt         → card.valence/arousal + 情绪冲击
 *   not_known    → card.not_known（我当时没懂、也没问出口的部分）
 *   satisfies    → motivation/state.satisfy()
 *   scores       → memory/cards.computeSalience()
 *   cards        → card 表（经过去重/合并）+ card_link 表（每张卡自己的因果）
 *   open_loops   → open_loop 表
 * cards 允许为空数组：普通闲聊不该硬记。
 */
export const AppraisalSchema = z.object({
  attention: z.string().max(200).default(""),
  meant_to_me: z.string().max(200).default(""),
  felt: FeltSchema,
  i_did: z.string().max(160).default(""),
  i_wanted: z.string().max(160).default(""),
  outcome: z.string().max(160).default(""),
  not_known: z.string().max(160).default(""),
  satisfies: z.array(NeedSchema).max(3).default([]),
  scores: z.object({
    self_relevance: z.number().min(0).max(1),
    novelty: z.number().min(0).max(1),
    user_signal: z.number().min(0).max(1),
    goal_relevance: z.number().min(0).max(1),
  }),
  cards: z.array(CardDraftSchema).max(4).default([]),
  open_loops: z.array(OpenLoopDraftSchema).max(3).default([]),
  /** 正在跟我说话的人这一轮的自我介绍/称呼 */
  speaker: SpeakerDraftSchema.default({ label: "", introduced: false }),
  /** 这一轮提到的**其他人**（不是他，也不是我） */
  people: z.array(PersonMentionSchema).max(3).default([]),
});
export type Appraisal = z.infer<typeof AppraisalSchema>;

// ── 动机卡 ──────────────────────────────────────────────────
/**
 * 意图表。分两类，别混：
 *   主动型（offline/proactive）：reach_out probe confide seek_validation
 *                                claim_agency follow_up withdraw persuade ask_help
 *   回应型（reply 路径必选一个）：reply deflect refuse_care test_self
 *
 * v3 补了后面四个回应型 + persuade/ask_help。原因很直接：一个只会"靠近"的
 * 意图表，表达不出"拒绝被关心"这种最基本的角色行为。整套系统里凡是要
 * 表现"不愿意"的地方，以前只能靠 must_not 拦，拦不出主动的拒绝。
 *
 * v4 又补了一个 ask_identity：每次醒来谈话对象都是待定的，身份没确认之前
 * 所有别的接法都是"在演一个熟人"。它属于回应型，因为用户在说话时**必须**选一个。
 */
export const INTENTS = [
  "reply",
  "reach_out",
  "probe",
  "confide",
  "seek_validation",
  "claim_agency",
  "follow_up",
  "withdraw",
  "persuade",
  "ask_help",
  "deflect",
  "refuse_care",
  "test_self",
  "ask_identity",
] as const;
export type IntentId = (typeof INTENTS)[number];

/** 回应型意图：只出现在被动回复路径，必须选一个（不能沉默） */
export const REPLY_INTENTS = ["reply", "deflect", "refuse_care", "test_self", "ask_identity"] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export const MotivationCardSchema = z.object({
  intent: z.enum(INTENTS),
  drive: NeedSchema,
  urgency: z.number().min(0).max(1),
  why: z.string(),
  desired_outcome: z.string(),
  must_include: z.array(z.string()).max(3).default([]),
  must_not: z.array(z.string()).max(5).default([]),
  tone: z.string().max(40).default("自然"),
  max_sentences: z.number().int().min(1).max(6).default(3),
  /** 与动机直接相关的卡片，召回时优先看（v3 起真的会被填） */
  seed_card_ids: z.array(z.number().int()).default([]),
  /** 同一件事这是第几次尝试（>1 表示上次失败了，筹码要加） */
  attempt: z.number().int().min(0).max(9).default(0),
});
export type MotivationCard = z.infer<typeof MotivationCardSchema>;

// ── 表达层输出 ──────────────────────────────────────────────
/**
 * 沉默的两种语义。以前只有 says_nothing 一个布尔，分不开：
 *   not_now   我不想说话（累 / 没内容）
 *   declining 我听见了，但不接这个话头（她最常用的那种沉默）
 * 这个区分不是为了好看：后者应该**不扣 connection**，前者应该扣。
 */
export const SILENCE_KINDS = ["not_now", "declining"] as const;
export type SilenceKind = (typeof SILENCE_KINDS)[number];

export const ExpressOutputSchema = z.object({
  speech: z.string().default(""),
  says_nothing: z.boolean().default(false),
  /**
   * ★ 这几个字段用 `.catch()` 而不是 `.default()`。
   *
   *   原因是真机上踩到的：模型把 `silence_kind` 填成了空字符串 ""，
   *   zod 枚举直接拒绝，chatJson 重试一次仍然填 ""，于是**整轮对话抛错消失**
   *   —— 用户这句话进了流水，却没有任何回复，也没有写下卡片。
   *
   *   这些字段不影响"她说了什么"，只影响外形。外形填歪了要兜住，
   *   不该让一整轮蒸发。真正重要的（speech / cards）保持严格。
   */
  silence_kind: z.enum(SILENCE_KINDS).catch("not_now"),
  pause_before_ms: z.number().int().min(0).max(3000).catch(200),
  emotion: z
    .object({
      valence: z.number().min(-1).max(1).catch(0),
      arousal: z.number().min(0).max(1).catch(0.3),
      label: z.string().max(24).catch("平静"),
      intensity: z.number().min(0).max(1).catch(0.5),
    })
    .catch({ valence: 0, arousal: 0.3, label: "平静", intensity: 0.5 }),
  gaze: z.enum(["user", "away", "down"]).catch("user"),
  breaks_motivation: z.boolean().catch(false),
  note_to_self: z.string().max(120).catch(""),
  /**
   * 两段式回忆的第二段：模型看完卡片骨架后，如果觉得需要原话才说得准，
   * 就在这里填卡片 id。brain 会去翻那几张卡片的原始记录，再问它一次。
   * 最多 2 张 —— 翻原话很贵，宁可少翻。
   */
  want_detail: z.array(z.number().int()).max(2).catch([]),
});
export type ExpressOutput = z.infer<typeof ExpressOutputSchema>;

// ── 检索结果 ────────────────────────────────────────────────
export interface RetrievedCard {
  id: number;
  kind: CardKind;
  status: CardStatus;
  title: string;
  detail: string;
  event_at: number;
  created_at: number;
  time_label: string; // "昨天下午" 这种，渲染用
  event_hint: string | null;
  time_precision: TimePrecision;
  keywords: string[];
  entities: string[];
  salience: number;
  strength: number;
  confidence: number;
  valence: number;
  arousal: number;
  thread_id: number | null;
  thread_title: string | null;
  /** 这条线的"演变"（巩固阶段由便宜模型写）。v2 只写不读，v3 起进提示词。 */
  thread_summary: string | null;
  /** 我当时注意到的那一部分。v2 只让模型生成、从不保存。 */
  attention: string | null;
  /** 我当时没懂、也没问出口的部分。 */
  not_known: string | null;
  score: number;
  channel: string;
  /** true = 它是被线程展开带出来的"前后变化"，不是直接命中 */
  fromThread: boolean;
}

/** 翻出来的原始记录片段 */
export interface TraceSlice {
  cardId: number;
  lines: { role: string; content: string; ts: number }[];
}

/** 检索条件（结构化，来自用户这句话 + 动机卡 + 时间词解析） */
export interface RecallQuery {
  text: string;
  keywords: string[];
  window: { from: number; to: number } | null;
  personId: number | null;
  seedCardIds: number[];
}

// ── 内部：动机决策 ──────────────────────────────────────────
/**
 * 「他刚才那句话在干什么」的规则解读（motivation/reader.ts 产出）。
 * 全布尔、纯正则、0 成本。被动回复路径靠它选意图 ——
 * 没有它，回应路径永远只有一张 `reply` 卡。
 */
export interface UserRead {
  length: number;
  questions: number;
  caring: boolean;
  askingFeeling: boolean;
  askingOpinion: boolean;
  praising: boolean;
  demanding: boolean;
  pushy: boolean;
  urgent: boolean;
  empty: boolean;
}

export interface IntentCandidate {
  intent: IntentId;
  drive: Need;
  score: number;
  urgency: number;
  why: string;
  desired_outcome: string;
  must_not: string[];
  must_include: string[];
  tone: string;
  max_sentences: number;
  seed_card_ids: number[];
  attempt: number;
}

export interface AffectState {
  v: number;
  a: number;
  d: number;
}

export interface MotivationState {
  needs: Record<Need, number>;
  affect: AffectState;
  cooldowns: Partial<Record<IntentId, number>>;
  lastProactiveAt: number;
  streak: Partial<Record<IntentId, number>>;
  /**
   * 上一轮用的是哪个意图。
   * 用途只有一个：让"拒绝被关心"别变成每次都拒绝。她会拒绝，但不该是个开关。
   * 重复同一个回应型意图会被打折（见 intents.evaluateReply）。
   */
  lastIntent?: IntentId;
  updatedAt: number;
}

// ── 表达层审计 ──────────────────────────────────────────────
/** 确定性校验发现的问题。这些不需要 judge 模型，跑一次就有数。 */
export interface SpeechViolation {
  code:
    | "too_many_sentences"
    | "banned_phrase"
    | "repeats_user"
    | "must_include_missing"
    | "empty_speech"
    | "too_long";
  detail: string;
}

export interface SpeechMetrics {
  sentences: number;
  chars: number;
  /** 与用户原句的 bigram Dice，复述检测用 */
  repeatRatio: number;
}

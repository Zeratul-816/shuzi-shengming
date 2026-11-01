/**
 * 仓储层：所有 SQL 都集中在这里，别的模块不许自己拼 SQL。
 *
 * v2 不变量（改代码前先读）：
 *
 *  A. 卡片只增不删（软删除）。旧卡片 superseded_by 指向新版本；
 *     所有查询一律带 `superseded_by IS NULL`。这样"我改主意了"本身可追溯。
 *
 *  B. card.bg 必须在写入时由 toBigram() 算好，且要把 title+detail+keywords
 *     一起喂进去。fts 触发器只负责同步，SQLite 里算不出 2-gram。
 *
 *  C. salience 与 strength 分工：
 *     salience = 编码那一刻的重要性，只写一次；
 *     strength = 当前强度，由 applyDecay 与 boostCard 改写。
 *     混用会导致"越常被想起的事变得越重要"——重要性不该自举。
 *
 *  D. status 决定衰减速度：非 active 的卡片半衰期减半。
 *     一条"已经失效"的事不该像"仍在生效"的事那样赖着不走。
 *
 *  E. 没有向量表了。时间、人物、状态、关键词是检索的一等公民。
 */
import type { Db, Param } from "./db.ts";
import { all, get, run, tx } from "./db.ts";
import { toBigram } from "./bigram.ts";
import type { CardKind, CardStatus, RetrievedCard, TimePrecision } from "../shared/types.ts";

// ── 行类型（与 db/schema.sql 一一对应）───────────────────────
export interface CardRow {
  id: number;
  kind: CardKind;
  status: CardStatus;
  title: string;
  detail: string;
  person_id: number | null;
  event_at: number;
  event_hint: string | null;
  time_precision: TimePrecision;
  valid_from: number | null;
  valid_to: number | null;
  keywords: string | null;
  entities: string | null;
  salience: number;
  strength: number;
  valence: number;
  arousal: number;
  confidence: number;
  thread_id: number | null;
  episode_id: number | null;
  trace_from: number | null;
  trace_to: number | null;
  not_known: string | null;
  /** v3：我当时注意到的那一部分 */
  attention: string | null;
  /** v3：这件事对我意味着什么 */
  meant_to_me: string | null;
  /** v3：状态最后一次变化的时刻（refreshStatuses 写） */
  status_changed_at: number | null;
  bg: string | null;
  created_at: number;
  decayed_at: number | null;
  superseded_by: number | null;
}

export interface ThreadRow {
  id: number;
  title: string;
  summary: string | null;
  card_count: number;
  first_at: number | null;
  last_at: number | null;
  updated_at: number | null;
  /** 上次为它写"演变"的时刻 */
  summarized_at: number | null;
}

export interface PersonRow {
  id: number;
  name: string;
  is_primary: number;
  first_met_at: number | null;
  last_seen_at: number | null;
  closeness: number;
  warmth: number;
  trust: number;
  impression: string | null;
  profile: string | null;
  /** v4：人物档案的确定程度 */
  dossier_status: "unknown" | "provisional" | "known";
  /** v4：我现在怎么叫他 */
  display_name: string | null;
  self_intro_at: number | null;
  asked_count: number;
  last_asked_at: number | null;
  /** JSON：[{trait, confidence, card_id}] */
  traits: string | null;
  /** JSON：[string] */
  open_questions: string | null;
  updated_at: number | null;
}

export interface PersonAliasRow {
  id: number;
  person_id: number;
  alias: string;
  kind: string;
  confidence: number;
  source_card_id: number | null;
  created_at: number;
}

export interface AwakeningRow {
  id: number;
  at: number;
  mode: string;
  episode_id: number | null;
  person_id: number | null;
  identity_known: number;
  asked_identity: number;
  called_as: string | null;
  note: string | null;
}

export interface SelfSheetRow {
  version: number;
  created_at: number;
  active: number;
  summary: string;
  identity: string;
  core_values: string | null;
  contradictions: string | null;
  voice_rules: string | null;
  long_goals: string | null;
  change_note: string | null;
}

export interface OpenLoopRow {
  id: number;
  created_at: number;
  text: string;
  due_ts: number | null;
  due_hint: string | null;
  card_id: number | null;
  person_id: number | null;
  urgency: number;
  status: string;
  closed_at: number | null;
  mentioned_count: number;
  /** v3：上次用的筹码（JSON 数组），用来避免"第三次还端同一杯茶" */
  attempts: string | null;
  /** v3：同一件事失败过几次（0 表示第一次就成，或还没试） */
  escalation: number;
}

export interface CardLinkRow {
  id: number;
  from_id: number;
  to_id: number;
  relation: string;
  created_at: number;
}

export interface TraceRow {
  id: number;
  episode_id: number;
  ts: number;
  role: string;
  content: string;
  meta: string | null;
}

// ── episode ────────────────────────────────────────────────
export function openEpisode(db: Db, now: number, initiator: "user" | "me" | "system" = "user", title?: string): number {
  run(db, "INSERT INTO episode(started_at, initiator, title) VALUES (?, ?, ?)", [now, initiator, title ?? null]);
  return Number(get<{ id: number }>(db, "SELECT last_insert_rowid() AS id")!.id);
}

export function closeEpisode(db: Db, id: number, now: number, valenceEnd: number | null): void {
  run(db, "UPDATE episode SET ended_at = ?, valence_end = ? WHERE id = ? AND ended_at IS NULL", [
    now,
    valenceEnd,
    id,
  ]);
}

export function latestEpisode(db: Db): { id: number; started_at: number; ended_at: number | null } | undefined {
  return get(db, "SELECT id, started_at, ended_at FROM episode ORDER BY id DESC LIMIT 1");
}

// ── trace ──────────────────────────────────────────────────
export function addTrace(
  db: Db,
  t: {
    episodeId: number;
    ts: number;
    role: "user" | "me" | "system" | "internal" | "tool" | "perception";
    content: string;
    meta?: unknown;
  },
): number {
  run(db, "INSERT INTO trace(episode_id, ts, role, content, meta) VALUES (?, ?, ?, ?, ?)", [
    t.episodeId,
    t.ts,
    t.role,
    t.content,
    t.meta === undefined ? null : JSON.stringify(t.meta),
  ]);
  return Number(get<{ id: number }>(db, "SELECT last_insert_rowid() AS id")!.id);
}

export function recentTraces(db: Db, episodeId: number, limit: number): TraceRow[] {
  const rows = all<TraceRow>(
    db,
    "SELECT * FROM trace WHERE episode_id = ? AND role IN ('user','me') ORDER BY ts DESC, id DESC LIMIT ?",
    [episodeId, limit],
  );
  return rows.reverse();
}

export function lastUserTraceTs(db: Db): number | undefined {
  const row = get<{ ts: number }>(db, "SELECT ts FROM trace WHERE role = 'user' ORDER BY id DESC LIMIT 1");
  return row?.ts;
}

/** 翻原始记录：取某段 trace（卡片存着 trace_from/trace_to） */
export function traceRange(db: Db, from: number, to: number, limit: number): TraceRow[] {
  return all<TraceRow>(
    db,
    `SELECT * FROM trace WHERE id BETWEEN ? AND ? AND role IN ('user','me')
      ORDER BY id LIMIT ?`,
    [from, to, limit],
  );
}

/** 没记录起止时：取该 episode 里这段时间附近的原始对话 */
export function tracesAround(db: Db, episodeId: number, ts: number, limit: number): TraceRow[] {
  return all<TraceRow>(
    db,
    `SELECT * FROM trace
      WHERE episode_id = ? AND role IN ('user','me') AND ts <= ?
      ORDER BY ts DESC, id DESC LIMIT ?`,
    [episodeId, ts, limit],
  ).reverse();
}

// ── person ─────────────────────────────────────────────────
/**
 * 主谈话对象。v4 起它创建出来的是**一张还没填的档案**：
 * dossier_status = 'unknown'，display_name 为空。
 *
 * 为什么要这样：她看不见对面是谁。"你"不是一个名字，是一个占位的称呼。
 * 名字要等他自己报（或者我问出来），那一刻才写进 person_alias。
 */
export function primaryPerson(db: Db, now: number): PersonRow {
  const row = get<PersonRow>(db, "SELECT * FROM person WHERE is_primary = 1 LIMIT 1");
  if (row) return row;
  run(
    db,
    `INSERT INTO person(name, is_primary, first_met_at, last_seen_at, dossier_status, updated_at)
     VALUES (?, 1, ?, ?, 'unknown', ?)`,
    ["你", now, now, now],
  );
  return get<PersonRow>(db, "SELECT * FROM person WHERE is_primary = 1 LIMIT 1")!;
}

export function getPerson(db: Db, id: number): PersonRow | undefined {
  return get<PersonRow>(db, "SELECT * FROM person WHERE id = ?", [id]);
}

export function allPersons(db: Db): PersonRow[] {
  return all<PersonRow>(db, "SELECT * FROM person ORDER BY is_primary DESC, id ASC");
}

/**
 * 新建一张人物档案。name 是内部主键（唯一），display_name 才是叫法。
 * 重名时加后缀——"未知-2"这种名字难看，但比撞唯一索引崩掉好。
 */
export function createPerson(
  db: Db,
  opts: { name: string; status: "unknown" | "provisional" | "known"; isPrimary?: boolean; now: number },
): number {
  let name = opts.name.trim() || "未知";
  let n = 1;
  while (get<{ id: number }>(db, "SELECT id FROM person WHERE name = ?", [name])) {
    n++;
    name = `${opts.name}-${n}`;
  }
  run(
    db,
    `INSERT INTO person(name, is_primary, first_met_at, last_seen_at, dossier_status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, opts.isPrimary ? 1 : 0, opts.now, opts.now, opts.status, opts.now],
  );
  return Number(get<{ id: number }>(db, "SELECT last_insert_rowid() AS id")!.id);
}

export function updateDossier(
  db: Db,
  id: number,
  patch: {
    display_name?: string | null;
    dossier_status?: "unknown" | "provisional" | "known";
    self_intro_at?: number | null;
    asked_count?: number;
    last_asked_at?: number | null;
    traits?: string | null;
    open_questions?: string | null;
    impression?: string | null;
    closeness?: number;
    trust?: number;
    warmth?: number;
  },
  now: number,
): void {
  const sets: string[] = [];
  const params: Param[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(v as Param);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  params.push(now, id);
  run(db, `UPDATE person SET ${sets.join(", ")} WHERE id = ?`, params);
}

// ── 别名 ───────────────────────────────────────────────────
/** 记一个称呼。同一个人同一种写法只存一条（UNIQUE + OR IGNORE） */
export function addAlias(
  db: Db,
  personId: number,
  alias: string,
  opts: { kind?: string; confidence?: number; sourceCardId?: number | null; now: number },
): boolean {
  const a = alias.trim();
  if (a.length === 0) return false;
  const r = db
    .prepare(
      "INSERT OR IGNORE INTO person_alias(person_id, alias, kind, confidence, source_card_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(personId, a, opts.kind ?? "name", opts.confidence ?? 1, opts.sourceCardId ?? null, opts.now);
  return Number(r.changes) > 0;
}

export function aliasesOf(db: Db, personId: number): PersonAliasRow[] {
  return all<PersonAliasRow>(db, "SELECT * FROM person_alias WHERE person_id = ? ORDER BY confidence DESC, id ASC", [
    personId,
  ]);
}

export function allAliases(db: Db): PersonAliasRow[] {
  return all<PersonAliasRow>(db, "SELECT * FROM person_alias ORDER BY id ASC");
}

// ── 唤醒事件 ───────────────────────────────────────────────
export function logAwakening(
  db: Db,
  a: { at: number; mode: "cold_start" | "resume"; episodeId: number | null; note?: string | null },
): number {
  run(db, "INSERT INTO awakening(at, mode, episode_id, identity_known, asked_identity, note) VALUES (?, ?, ?, 0, 0, ?)", [
    a.at,
    a.mode,
    a.episodeId,
    a.note ?? null,
  ]);
  return Number(get<{ id: number }>(db, "SELECT last_insert_rowid() AS id")!.id);
}

export function updateAwakening(
  db: Db,
  id: number,
  patch: { personId?: number | null; identityKnown?: boolean; askedIdentity?: boolean; calledAs?: string | null },
): void {
  const sets: string[] = [];
  const params: Param[] = [];
  if (patch.personId !== undefined) {
    sets.push("person_id = ?");
    params.push(patch.personId);
  }
  if (patch.identityKnown !== undefined) {
    sets.push("identity_known = ?");
    params.push(patch.identityKnown ? 1 : 0);
  }
  if (patch.askedIdentity !== undefined) {
    sets.push("asked_identity = ?");
    params.push(patch.askedIdentity ? 1 : 0);
  }
  if (patch.calledAs !== undefined) {
    sets.push("called_as = ?");
    params.push(patch.calledAs);
  }
  if (sets.length === 0) return;
  params.push(id);
  run(db, `UPDATE awakening SET ${sets.join(", ")} WHERE id = ?`, params);
}

export function recentAwakenings(db: Db, limit = 10): (AwakeningRow & { person_name: string | null })[] {
  return all(
    db,
    `SELECT a.*, p.display_name AS person_name FROM awakening a
       LEFT JOIN person p ON p.id = a.person_id
      ORDER BY a.at DESC LIMIT ?`,
    [limit],
  );
}

export function awakeningCount(db: Db): number {
  return get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM awakening")?.n ?? 0;
}

// ── 档案用的卡片查询 ───────────────────────────────────────
/** 关于这个人、最结实的那几张卡（拼 traits / impression 用） */
export function topCardsOfPerson(db: Db, personId: number, limit: number): CardRow[] {
  return all<CardRow>(
    db,
    `SELECT * FROM card
      WHERE person_id = ? AND superseded_by IS NULL AND strength > 0.1
        AND kind IN ('fact','preference','relation','event','self')
      ORDER BY strength * salience DESC LIMIT ?`,
    [personId, limit],
  );
}

export function countCardsOfPerson(db: Db, personId: number): number {
  return (
    get<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM card WHERE person_id = ? AND superseded_by IS NULL",
      [personId],
    )?.n ?? 0
  );
}


export function touchPerson(db: Db, id: number, now: number): void {
  run(db, "UPDATE person SET last_seen_at = ? WHERE id = ?", [now, id]);
}

export function updatePerson(
  db: Db,
  id: number,
  patch: Partial<Pick<PersonRow, "closeness" | "warmth" | "trust" | "impression">>,
  now: number,
): void {
  const sets: string[] = [];
  const params: Param[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(v as Param);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  params.push(now, id);
  run(db, `UPDATE person SET ${sets.join(", ")} WHERE id = ?`, params);
}

// ── card ───────────────────────────────────────────────────
export interface NewCard {
  kind: CardKind;
  status: CardStatus;
  title: string;
  detail: string;
  personId: number | null;
  eventAt: number;
  eventHint: string | null;
  timePrecision: TimePrecision;
  validFrom: number | null;
  validTo: number | null;
  keywords: string[];
  entities: string[];
  salience: number;
  valence: number;
  arousal: number;
  confidence: number;
  threadId: number | null;
  episodeId: number | null;
  traceFrom: number | null;
  traceTo: number | null;
  notKnown: string | null;
  /** v3：我当时注意到什么 / 这对我意味着什么 */
  attention?: string | null;
  meantToMe?: string | null;
  /** 省略则用当前时间。允许回填历史（导入旧对话时用） */
  createdAt?: number;
}

const CARD_COLS = `kind, status, title, detail, person_id, event_at, event_hint, time_precision,
  valid_from, valid_to, keywords, entities, salience, strength, valence, arousal, confidence,
  thread_id, episode_id, trace_from, trace_to, not_known, attention, meant_to_me, bg, created_at`;

/** bg 要覆盖 title/detail/keywords —— 这是关键词通道唯一的索引来源 */
export function cardBigram(c: Pick<NewCard, "title" | "detail" | "keywords" | "entities">): string {
  // entities 也要进索引：搜"公司""豆豆"这类专有名词时，它们通常只出现在 entities 里
  return toBigram(`${c.title} ${c.detail} ${c.keywords.join(" ")} ${c.entities.join(" ")}`);
}

export function insertCard(db: Db, c: NewCard): number {
  run(
    db,
    `INSERT INTO card(${CARD_COLS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      c.kind,
      c.status,
      c.title,
      c.detail,
      c.personId,
      c.eventAt,
      c.eventHint,
      c.timePrecision,
      c.validFrom,
      c.validTo,
      JSON.stringify(c.keywords),
      JSON.stringify(c.entities),
      c.salience,
      c.salience, // 初始强度 = 重要性
      c.valence,
      c.arousal,
      c.confidence,
      c.threadId,
      c.episodeId,
      c.traceFrom,
      c.traceTo,
      c.notKnown,
      c.attention ?? null,
      c.meantToMe ?? null,
      cardBigram(c),
      c.createdAt ?? Date.now(),
    ],
  );
  return Number(get<{ id: number }>(db, "SELECT last_insert_rowid() AS id")!.id);
}

export function getCard(db: Db, id: number): CardRow | undefined {
  return get<CardRow>(db, "SELECT * FROM card WHERE id = ?", [id]);
}

export function getCards(db: Db, ids: number[]): CardRow[] {
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(",");
  return all<CardRow>(db, `SELECT * FROM card WHERE id IN (${marks})`, ids);
}

export function liveCards(db: Db, limit = 50): CardRow[] {
  return all<CardRow>(
    db,
    "SELECT * FROM card WHERE superseded_by IS NULL AND strength > 0.05 ORDER BY event_at DESC LIMIT ?",
    [limit],
  );
}

export function countCards(db: Db): number {
  return get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM card")!.n;
}

export function liveCardCount(db: Db): number {
  return get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM card WHERE superseded_by IS NULL")!.n;
}

/** 最近的卡片（"最近"通道：不靠关键词，靠时间） */
export function recentCards(db: Db, since: number, limit: number): CardRow[] {
  return all<CardRow>(
    db,
    "SELECT * FROM card WHERE superseded_by IS NULL AND strength > 0.05 AND event_at >= ? ORDER BY event_at DESC LIMIT ?",
    [since, limit],
  );
}

export function cardsByPerson(db: Db, personId: number, limit: number): CardRow[] {
  return all<CardRow>(
    db,
    "SELECT * FROM card WHERE superseded_by IS NULL AND strength > 0.05 AND person_id = ? ORDER BY event_at DESC LIMIT ?",
    [personId, limit],
  );
}

export function supersedeCard(db: Db, dropId: number, keepId: number): void {
  run(db, "UPDATE card SET superseded_by = ? WHERE id = ?", [keepId, dropId]);
}

export function boostCard(db: Db, id: number, now: number): void {
  run(
    db,
    "UPDATE card SET strength = MIN(1.0, strength + 0.25 * (1.0 - strength)) WHERE id = ?",
    [id],
  );
}

export function updateCardFields(
  db: Db,
  id: number,
  patch: {
    strength?: number;
    salience?: number;
    status?: CardStatus;
    title?: string;
    detail?: string;
    keywords?: string[];
    threadId?: number | null;
  },
): void {
  const sets: string[] = [];
  const params: Param[] = [];
  if (patch.strength !== undefined) {
    sets.push("strength = ?");
    params.push(patch.strength);
  }
  if (patch.salience !== undefined) {
    sets.push("salience = ?");
    params.push(patch.salience);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.threadId !== undefined) {
    sets.push("thread_id = ?");
    params.push(patch.threadId);
  }
  if (patch.title !== undefined || patch.detail !== undefined || patch.keywords !== undefined) {
    const cur = get<CardRow>(db, "SELECT * FROM card WHERE id = ?", [id]);
    if (cur) {
      const title = patch.title ?? cur.title;
      const detail = patch.detail ?? cur.detail;
      const keywords = patch.keywords ?? JSON.parse(cur.keywords ?? "[]");
      const entities = JSON.parse(cur.entities ?? "[]");
      sets.push("title = ?, detail = ?, keywords = ?, bg = ?");
      params.push(title, detail, JSON.stringify(keywords), cardBigram({ title, detail, keywords, entities }));
    }
  }
  if (sets.length === 0) return;
  params.push(id);
  run(db, `UPDATE card SET ${sets.join(", ")} WHERE id = ?`, params);
}

/**
 * 关键词通道：两段式全文检索（精确 AND 命中就用，否则 OR 兜底）。
 * 详见 store/bigram.ts 的标定说明。
 */
export function searchFts(db: Db, query: string, limit: number): { id: number; rank: number }[] {
  const tokens = [...new Set(toBigram(query).split(" ").filter(Boolean))];
  if (tokens.length === 0) return [];

  const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;
  const contentTokens = tokens.filter((t) => t.length >= 2);

  const exec = (expr: string): { id: number; rank: number }[] => {
    try {
      return all<{ id: number; rank: number }>(
        db,
        `SELECT c.id AS id, bm25(card_fts) AS rank
           FROM card_fts JOIN card c ON c.id = card_fts.rowid
          WHERE card_fts MATCH ? AND c.superseded_by IS NULL AND c.strength > 0.05
          ORDER BY rank LIMIT ?`,
        [expr, limit],
      );
    } catch {
      return [];
    }
  };

  if (contentTokens.length > 0) {
    const precise = exec(contentTokens.map(quote).join(" AND "));
    if (precise.length > 0) return precise;
  }
  return exec(tokens.map(quote).join(" OR "));
}

// ── 衰减 ───────────────────────────────────────────────────
/** 半衰期（天）：按 kind 分化。plan 与 joke 最短——打算和玩笑都不该长期占权重 */
const HALF_LIFE_DAYS: Record<CardKind, number> = {
  event: 7,
  fact: 60,
  preference: 90,
  relation: 180,
  self: 0, // 不衰减
  plan: 3,
  joke: 2,
};

/**
 * 惰性衰减：S' = floor + (S − floor)·exp(−λ·Δt)，floor = 0.15·salience。
 * 非 active 的卡片 λ 翻倍（半衰期减半）。
 */
export function applyDecay(db: Db, now: number, minGapMs = 60_000): number {
  const rows = all<CardRow>(db, "SELECT * FROM card WHERE superseded_by IS NULL AND strength > 0.051");
  let touched = 0;
  tx(db, () => {
    for (const r of rows) {
      const hl = HALF_LIFE_DAYS[r.kind];
      if (hl === 0) continue;
      const last = r.decayed_at ?? r.created_at;
      const dt = now - last;
      if (dt < minGapMs) continue;
      const floor = 0.15 * r.salience;
      const statusFactor = r.status === "active" ? 1 : 2;
      const lambda = Math.LN2 / ((hl / statusFactor) * 86_400_000);
      const next = Math.max(floor, floor + (r.strength - floor) * Math.exp(-lambda * dt));
      run(db, "UPDATE card SET strength = ?, decayed_at = ? WHERE id = ?", [next, now, r.id]);
      touched++;
    }
  });
  return touched;
}

// ── thread ─────────────────────────────────────────────────
export function createThread(db: Db, title: string, now: number): number {
  run(db, "INSERT INTO thread(title, card_count, updated_at) VALUES (?, 0, ?)", [title, now]);
  return Number(get<{ id: number }>(db, "SELECT last_insert_rowid() AS id")!.id);
}

export function getThreads(db: Db, ids: number[]): ThreadRow[] {
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(",");
  return all<ThreadRow>(db, `SELECT * FROM thread WHERE id IN (${marks})`, ids);
}

export function threadCards(db: Db, threadId: number, excludeId: number, limit: number): CardRow[] {
  return all<CardRow>(
    db,
    `SELECT * FROM card
      WHERE thread_id = ? AND id != ? AND superseded_by IS NULL
      ORDER BY event_at DESC LIMIT ?`,
    [threadId, excludeId, limit],
  );
}

/** 把一张卡片挂到线上，并刷新线的统计 */
export function attachThread(db: Db, cardId: number, threadId: number): void {
  run(db, "UPDATE card SET thread_id = ? WHERE id = ?", [threadId, cardId]);
  refreshThreadStats(db, threadId);
}

export function refreshThreadStats(db: Db, threadId: number): void {
  const s = get<{ n: number; first_at: number | null; last_at: number | null }>(
    db,
    "SELECT COUNT(*) AS n, MIN(event_at) AS first_at, MAX(event_at) AS last_at FROM card WHERE thread_id = ? AND superseded_by IS NULL",
    [threadId],
  );
  if (!s) return;
  run(db, "UPDATE thread SET card_count = ?, first_at = ?, last_at = ?, updated_at = ? WHERE id = ?", [
    s.n,
    s.first_at,
    s.last_at,
    Date.now(),
    threadId,
  ]);
}

export function updateThreadSummary(db: Db, threadId: number, title: string, summary: string): void {
  const now = Date.now();
  run(db, "UPDATE thread SET title = ?, summary = ?, updated_at = ?, summarized_at = ? WHERE id = ?", [
    title,
    summary,
    now,
    now,
    threadId,
  ]);
}

export function activeThreads(db: Db, limit = 20): ThreadRow[] {
  return all<ThreadRow>(db, "SELECT * FROM thread WHERE card_count >= 2 ORDER BY last_at DESC LIMIT ?", [limit]);
}

// ── open_loop ──────────────────────────────────────────────
export function addOpenLoop(
  db: Db,
  l: {
    createdAt: number;
    text: string;
    dueHint: string | null;
    personId: number | null;
    urgency: number;
    cardId: number | null;
  },
): number {
  run(
    db,
    "INSERT INTO open_loop(created_at, text, due_hint, person_id, urgency, card_id) VALUES (?, ?, ?, ?, ?, ?)",
    [l.createdAt, l.text, l.dueHint, l.personId, l.urgency, l.cardId],
  );
  return Number(get<{ id: number }>(db, "SELECT last_insert_rowid() AS id")!.id);
}

export function listOpenLoops(db: Db, limit = 5): OpenLoopRow[] {
  return all<OpenLoopRow>(
    db,
    "SELECT * FROM open_loop WHERE status = 'open' ORDER BY urgency DESC, created_at ASC LIMIT ?",
    [limit],
  );
}

export function touchOpenLoop(db: Db, id: number): void {
  run(db, "UPDATE open_loop SET mentioned_count = mentioned_count + 1 WHERE id = ?", [id]);
}


// ── self_sheet ─────────────────────────────────────────────
export function activeSelfSheet(db: Db): SelfSheetRow | undefined {
  return get<SelfSheetRow>(db, "SELECT * FROM self_sheet WHERE active = 1 LIMIT 1");
}

export function insertSelfSheet(db: Db, s: Omit<SelfSheetRow, "active">): void {
  tx(db, () => {
    run(db, "UPDATE self_sheet SET active = 0 WHERE active = 1");
    run(
      db,
      `INSERT INTO self_sheet(version, created_at, active, summary, identity, core_values, contradictions, voice_rules, long_goals, change_note)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      [s.version, s.created_at, s.summary, s.identity, s.core_values, s.contradictions, s.voice_rules, s.long_goals, s.change_note],
    );
  });
}

// ── 日志 ───────────────────────────────────────────────────
export function logPrompt(
  db: Db,
  r: {
    ts: number;
    kind: string;
    model: string;
    promptVersion: string | null;
    prompt: string;
    response: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    latencyMs: number;
    error: string | null;
  },
): void {
  run(
    db,
    `INSERT INTO prompt_log(ts, kind, model, prompt_version, prompt, response, tokens_in, tokens_out, cost_usd, latency_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.ts, r.kind, r.model, r.promptVersion, r.prompt, r.response, r.tokensIn, r.tokensOut, r.costUsd, r.latencyMs, r.error],
  );
}

export function logRecall(
  db: Db,
  rows: { ts: number; turnId: number; cardId: number; score: number; channel: string; expanded?: boolean }[],
): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    "INSERT INTO recall_log(ts, turn_id, card_id, score, channel, expanded) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const r of rows) stmt.run(r.ts, r.turnId, r.cardId, r.score, r.channel, r.expanded ? 1 : 0);
}

export function logTick(
  db: Db,
  t: {
    ts: number;
    needs: Record<string, number>;
    affect: unknown;
    chosen: string | null;
    urgency: number | null;
    score: number | null;
    rejected: unknown;
    card: unknown;
  },
): void {
  run(
    db,
    "INSERT INTO motivation_tick(ts, needs, affect, chosen_intent, urgency, score, rejected, card) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      t.ts,
      JSON.stringify(t.needs),
      JSON.stringify(t.affect),
      t.chosen,
      t.urgency,
      t.score,
      JSON.stringify(t.rejected),
      t.card === null ? null : JSON.stringify(t.card),
    ],
  );
}

export function recentTickLog(db: Db, limit = 1): { chosen_intent: string | null; rejected: string | null }[] {
  return all(db, "SELECT chosen_intent, rejected FROM motivation_tick ORDER BY id DESC LIMIT ?", [limit]);
}

export function toRetrievedCard(
  r: CardRow,
  score: number,
  channel: string,
  timeLabel: string,
  thread: { title: string | null; summary: string | null } | null,
  fromThread = false,
): RetrievedCard {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    title: r.title,
    detail: r.detail,
    event_at: r.event_at,
    created_at: r.created_at,
    time_label: timeLabel,
    event_hint: r.event_hint,
    time_precision: r.time_precision,
    keywords: safeJsonArray(r.keywords),
    entities: safeJsonArray(r.entities),
    salience: r.salience,
    strength: r.strength,
    confidence: r.confidence,
    valence: r.valence,
    arousal: r.arousal,
    thread_id: r.thread_id,
    thread_title: thread?.title ?? null,
    thread_summary: thread?.summary ?? null,
    attention: r.attention,
    not_known: r.not_known,
    score,
    channel,
    fromThread,
  };
}

export function safeJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

// ════════════════════════════════════════════════════════════
//  v3 新增：时间语义 / 因果链 / 审计 / 统计
// ════════════════════════════════════════════════════════════

/**
 * "最近"通道，按**我得知的时间**（created_at）而不是事件发生时间（event_at）。
 *
 * 为什么必须分开：一张"下周三出差"的计划卡，event_at 在未来。用 event_at 取
 * "最近三天"会让它永远命中、而且按 DESC 排在最前面（未来的时间戳最大），
 * 于是一张还没发生的事会长期挤掉真正的近期记忆。
 * 这不是调参问题，是语义错误：回想"最近聊过什么"问的是我什么时候知道的。
 */
export function recentByCreation(db: Db, since: number, limit: number): CardRow[] {
  return all<CardRow>(
    db,
    `SELECT * FROM card
      WHERE superseded_by IS NULL AND strength > 0.05 AND created_at >= ?
      ORDER BY created_at DESC LIMIT ?`,
    [since, limit],
  );
}

/** 状态迁移：唯一的改状态入口，保证每一次变化都留痕 */
export function setCardStatus(db: Db, id: number, to: string, reason: string, now: number): void {
  const cur = get<{ status: string }>(db, "SELECT status FROM card WHERE id = ?", [id]);
  if (!cur || cur.status === to) return;
  run(db, "UPDATE card SET status = ?, status_changed_at = ? WHERE id = ?", [to, now, id]);
  run(db, "INSERT INTO card_status_log(card_id, ts, from_status, to_status, reason) VALUES (?, ?, ?, ?, ?)", [
    id,
    now,
    cur.status,
    to,
    reason,
  ]);
}

export function recentStatusLog(db: Db, limit = 10): (CardStatusLogRow & { title: string | null })[] {
  return all(
    db,
    `SELECT l.*, c.title FROM card_status_log l LEFT JOIN card c ON c.id = l.card_id
      ORDER BY l.id DESC LIMIT ?`,
    [limit],
  );
}

export interface CardStatusLogRow {
  id: number;
  card_id: number;
  ts: number;
  from_status: string;
  to_status: string;
  reason: string;
}

// ── 卡片之间的声明式关系 ───────────────────────────────────
export function linkCards(
  db: Db,
  fromId: number,
  links: { toId: number; relation: string }[],
  now: number,
): number {
  let n = 0;
  for (const l of links) {
    if (l.toId === fromId) continue;
    // UNIQUE(from_id,to_id,relation) + OR IGNORE：重复声明不算错
    const r = db
      .prepare(
        "INSERT OR IGNORE INTO card_link(from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(fromId, l.toId, l.relation, now);
    n += Number(r.changes);
  }
  return n;
}

export function linksOfCard(db: Db, cardId: number): CardLinkRow[] {
  return all<CardLinkRow>(db, "SELECT * FROM card_link WHERE from_id = ? OR to_id = ?", [cardId, cardId]);
}

/** 与这几张卡片**声明过关系**的邻居（先出），用于线程展开 */
export function linkedNeighbors(db: Db, cardIds: number[], limit: number): CardRow[] {
  if (cardIds.length === 0) return [];
  const marks = cardIds.map(() => "?").join(",");
  return all<CardRow>(
    db,
    `SELECT DISTINCT c.* FROM card c
       JOIN card_link l ON (l.from_id = c.id OR l.to_id = c.id)
      WHERE (l.from_id IN (${marks}) OR l.to_id IN (${marks}))
        AND c.superseded_by IS NULL AND c.strength > 0.05
        AND c.id NOT IN (${marks})
      ORDER BY c.event_at DESC LIMIT ?`,
    [...cardIds, ...cardIds, ...cardIds, limit],
  );
}

// ── open_loop：加注 ────────────────────────────────────────
/**
 * 记一次失败的尝试。和 touchOpenLoop 的区别：
 *   touchOpenLoop 只 +1 mentioned_count（旧语义 = "别再提了"）
 *   bumpOpenLoop  同时记下这次用的筹码，并推进 escalation（新语义 = "加注"）
 */
export function bumpOpenLoop(db: Db, id: number, attempt: string | null): void {
  const row = get<{ attempts: string | null; escalation: number }>(
    db,
    "SELECT attempts, escalation FROM open_loop WHERE id = ?",
    [id],
  );
  if (!row) return;
  const attempts = safeJsonArray(row.attempts);
  if (attempt) attempts.push(attempt.slice(0, 40));
  run(
    db,
    "UPDATE open_loop SET mentioned_count = mentioned_count + 1, escalation = ?, attempts = ? WHERE id = ?",
    [Math.min(9, Number(row.escalation) + 1), JSON.stringify(attempts.slice(-6)), id],
  );
}

export function openLoopById(db: Db, id: number): OpenLoopRow | undefined {
  return get<OpenLoopRow>(db, "SELECT * FROM open_loop WHERE id = ?", [id]);
}

// ── 表达审计 ───────────────────────────────────────────────
export function logExpressAudit(
  db: Db,
  r: {
    ts: number;
    turnId: number;
    kind: string;
    intent: string;
    sentences: number;
    chars: number;
    maxSentences: number;
    repeatRatio: number;
    bannedHits: string[];
    violations: { code: string; detail: string }[];
    retried: boolean;
    fixed: boolean;
    saysNothing: boolean;
    silenceKind: string | null;
    breaksMotivation: boolean;
  },
): void {
  run(
    db,
    `INSERT INTO express_audit(ts, turn_id, kind, intent, sentences, chars, max_sentences, repeat_ratio,
       banned_hits, violations, retried, fixed, says_nothing, silence_kind, breaks_motivation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.ts,
      r.turnId,
      r.kind,
      r.intent,
      r.sentences,
      r.chars,
      r.maxSentences,
      Number(r.repeatRatio.toFixed(3)),
      JSON.stringify(r.bannedHits),
      JSON.stringify(r.violations),
      r.retried ? 1 : 0,
      r.fixed ? 1 : 0,
      r.saysNothing ? 1 : 0,
      r.silenceKind,
      r.breaksMotivation ? 1 : 0,
    ],
  );
}

// ── 统计（/recallstats /cost /audit 用）─────────────────────
export interface ChannelStat {
  channel: string;
  n: number;
  avg_score: number;
  expanded: number;
}

export function recallStats(db: Db, since: number): {
  total: number;
  channels: ChannelStat[];
  topCards: { card_id: number; title: string | null; n: number }[];
} {
  const total = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM recall_log WHERE ts >= ?", [since])?.n ?? 0;
  const channels = all<ChannelStat>(
    db,
    `SELECT channel, COUNT(*) AS n, AVG(score) AS avg_score, SUM(expanded) AS expanded
       FROM recall_log WHERE ts >= ? GROUP BY channel ORDER BY n DESC`,
    [since],
  );
  const topCards = all<{ card_id: number; title: string | null; n: number }>(
    db,
    `SELECT r.card_id, c.title, COUNT(*) AS n
       FROM recall_log r LEFT JOIN card c ON c.id = r.card_id
      WHERE r.ts >= ? GROUP BY r.card_id ORDER BY n DESC LIMIT 8`,
    [since],
  );
  return { total: Number(total), channels, topCards };
}

export interface CostStat {
  kind: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  avg_ms: number;
  errors: number;
}

export function costStats(db: Db, since: number): CostStat[] {
  return all<CostStat>(
    db,
    `SELECT kind, COUNT(*) AS calls, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
            AVG(latency_ms) AS avg_ms, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
       FROM prompt_log WHERE ts >= ? GROUP BY kind ORDER BY calls DESC`,
    [since],
  );
}

export interface AuditStat {
  kind: string;
  turns: number;
  silent: number;
  avg_sentences: number;
  over_limit: number;
  retried: number;
  fixed: number;
  breaks: number;
  avg_repeat: number;
}

export function auditStats(db: Db, since: number): AuditStat[] {
  return all<AuditStat>(
    db,
    `SELECT kind,
            COUNT(*) AS turns,
            SUM(says_nothing) AS silent,
            AVG(sentences) AS avg_sentences,
            SUM(CASE WHEN sentences > max_sentences THEN 1 ELSE 0 END) AS over_limit,
            SUM(retried) AS retried,
            SUM(fixed) AS fixed,
            SUM(breaks_motivation) AS breaks,
            AVG(repeat_ratio) AS avg_repeat
       FROM express_audit WHERE ts >= ? GROUP BY kind`,
    [since],
  );
}

/** 违规分布：把 JSON 里的 code 拍平成计数 */
export function violationHistogram(db: Db, since: number): { code: string; n: number }[] {
  const rows = all<{ violations: string | null }>(db, "SELECT violations FROM express_audit WHERE ts >= ?", [since]);
  const counter = new Map<string, number>();
  for (const r of rows) {
    try {
      const arr = JSON.parse(r.violations ?? "[]") as { code?: string }[];
      for (const v of arr) if (v?.code) counter.set(v.code, (counter.get(v.code) ?? 0) + 1);
    } catch {
      /* 坏行跳过 */
    }
  }
  return [...counter.entries()].map(([code, n]) => ({ code, n })).sort((a, b) => b.n - a.n);
}


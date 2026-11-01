-- ============================================================
--  数字生命 · 记忆库 Schema  v3（卡片制，无向量；因果链 + 审计）
--
--  为什么没有向量表：
--    纯语义相似度没有时间轴，也没有"是否仍然成立"的概念。
--    三周前的一句玩笑和昨天的一句陈述，在向量空间里可能比同一件事的
--    前后两种说法更近。于是会出现"把很久以前已失效的事当成现状"。
--    所以检索的第一等公民是**结构化字段**：时间、人物、关键词、状态。
--
--  分层：
--    trace  ── 原始流水（逐字），不参与检索，只能经由 card 的指针翻页
--    card   ── 检索单元：一条自足的事实/事件/玩笑，带时间与状态
--    card_link ── 卡片之间**声明式**的因果（串线的第一依据，猜的其次）
--    thread ── 来龙去脉：同一件事的多次变化按时间串起来
--    self_sheet ── 人格锚（慢变量）
--
--  ★ 版本策略（改之前先读）
--    schema_version 只在**破坏性变更**（改列名/改类型/删表）时才 +1，
--    那时 store/db.ts 会整份备份旧库再重建（没有迁移器）。
--    纯增量（加列/加表）**不升版本**：schema.sql 全部 IF NOT EXISTS，
--    旧库缺的列由 db.ts 的 ensureColumn() 补。这样用户现成的记忆库不会丢。
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;

-- ------------------------------------------------------------
-- 0. 元信息
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '2');

-- ------------------------------------------------------------
-- 1. 情节 Episode —— 一段连续的相处
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS episode (
  id             INTEGER PRIMARY KEY,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  title          TEXT,
  digest         TEXT,
  valence_start  REAL,
  valence_end    REAL,
  initiator      TEXT CHECK (initiator IN ('user','me','system')),
  card_count     INTEGER NOT NULL DEFAULT 0,
  consolidated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_episode_time ON episode(started_at);

-- ------------------------------------------------------------
-- 2. 原始轨迹 Trace —— 逐字流水，append-only
--    ★ 不参与检索。只有 card.trace_from / trace_to 指向的那一段会被翻出来。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trace (
  id         INTEGER PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES episode(id) ON DELETE CASCADE,
  ts         INTEGER NOT NULL,
  role       TEXT NOT NULL CHECK (role IN
              ('user','me','system','internal','tool','perception')),
  content    TEXT NOT NULL,
  meta       TEXT
);
CREATE INDEX IF NOT EXISTS idx_trace_ep   ON trace(episode_id, ts, id);
CREATE INDEX IF NOT EXISTS idx_trace_time ON trace(ts);

-- ------------------------------------------------------------
-- 3. 人 Person —— v4 起是真正的「人物档案」
--
-- v3 之前这张表只有一个槽位：name 硬编码成「你」，impression 永远是 NULL。
-- 35 张卡片的 person_id 全是 1，不是因为它们属于同一个人，而是因为没有
-- 第二个人可指。名字他其实报过（「开发者」），只是没地方挂。
--
-- dossier_status 三种状态，区别很重要：
--   unknown     不知道对面是谁（刚醒来）
--   provisional 有个临时叫法，但没确认过
--   known       他自己报过名，或被清楚指认过
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,   -- 内部主键式的称呼，不一定是他的名字
  is_primary   INTEGER NOT NULL DEFAULT 0,
  first_met_at INTEGER,
  last_seen_at INTEGER,
  closeness    REAL NOT NULL DEFAULT 0.30,
  warmth       REAL NOT NULL DEFAULT 0.5,
  trust        REAL NOT NULL DEFAULT 0.5,
  impression   TEXT,
  profile      TEXT,
  dossier_status TEXT NOT NULL DEFAULT 'known'
                 CHECK (dossier_status IN ('unknown','provisional','known')),
  /** 我现在该怎么称呼他。NULL = 还没有叫法 */
  display_name   TEXT,
  /** **他自己**报名字的时刻（不是第一次见面） */
  self_intro_at  INTEGER,
  /** 我问过几次「你是谁」，以及最后一次是什么时候 —— 问三次还不说就不问了 */
  asked_count    INTEGER NOT NULL DEFAULT 0,
  last_asked_at  INTEGER,
  /** 我知道的关于他的属性，JSON：[{trait, confidence, card_id}] */
  traits         TEXT,
  /** 关于他我还没弄清的问题，JSON：[string] */
  open_questions TEXT,
  updated_at   INTEGER
);

-- ------------------------------------------------------------
-- 3b. 人物别名索引（v4）
--
-- 一个人有多条入口：他自称「开发者」，我叫他「你」，卡片里提到的可能是「小林」。
-- 没有这张表，这三种写法在系统里是三个互不相干的字符串，
-- 于是"我知道的关于他的事"永远归不到一处。
--
-- 两个方向都要用：
--   写入：他自报的称呼 / 卡片上的 about → 命中别名 → 这张卡归到那个人
--   读取：现在在跟谁说话 → 他有哪些称呼 → 进提示词
--
-- 注意：**不从 entities 建人物**。那里面混着「公司」「报错」，还有她自己的名字。
-- 但"她把自己的名字和他认混"是允许发生的 —— 那不是这张表要防的事。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person_alias (
  id             INTEGER PRIMARY KEY,
  person_id      INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  alias          TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'name'
                 CHECK (kind IN ('name','nickname','handle','role','pronoun')),
  confidence     REAL NOT NULL DEFAULT 1,
  source_card_id INTEGER,
  created_at     INTEGER NOT NULL,
  UNIQUE(person_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_alias_text ON person_alias(alias);

-- ------------------------------------------------------------
-- 3c. 唤醒事件（v4）
--
-- 「每一次唤醒作为一个事件」。它和 episode 不是一回事：
--   episode    一段相处（可以跨越多次唤醒）
--   awakening  我这一次睁开眼睛
--
-- 为什么单独记：她看不见对面是谁。每次醒来，谈话对象都是**待定**的，
-- 这一行 identity_known = 0 就是"这一次我又得先问清楚"。
-- 顺带治掉 v3 的毛病：重启会造 0 张卡、十几秒的垃圾 episode——
-- 那在 awakening 里是一条正常记录，在 episode 里是噪音。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS awakening (
  id             INTEGER PRIMARY KEY,
  at             INTEGER NOT NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('cold_start','resume')),
  episode_id     INTEGER,
  /** 醒来时认定的谈话对象（NULL = 完全不知道） */
  person_id      INTEGER,
  /** 1 = 醒来就知道是谁（现在的实现总是 0，留给以后做声纹/账号识别） */
  identity_known INTEGER NOT NULL DEFAULT 0,
  /** 这一次我有没有问过"你是谁" */
  asked_identity INTEGER NOT NULL DEFAULT 0,
  /** 他这次叫我什么（听到「艾拉」就记下来） */
  called_as      TEXT,
  note           TEXT
);
CREATE INDEX IF NOT EXISTS idx_awakening_time ON awakening(at);

-- ------------------------------------------------------------
-- 4. 卡片 Card —— 检索与提示词的基本单位
--
--    kind   讲"这是什么"
--    status 讲"现在还成立吗"  ← 这一列是防"把玩笑当事实"的关键
--    time_precision 讲"时间有多准"，检索时据此决定要不要放宽时间窗
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN
                   ('event',      -- 发生过的一件事
                    'fact',       -- 一条稳定的事实
                    'preference', -- 他的喜好/习惯
                    'relation',   -- 我们之间
                    'self',       -- 关于我自己
                    'plan',       -- 打算做还没做
                    'joke')),     -- 玩笑/反讽/假设——不是事实
  status         TEXT NOT NULL CHECK (status IN
                   ('active',     -- 现在仍然成立
                    'expired',    -- 曾经成立，已失效
                    'retracted',  -- 后来说过不是这样/改口了
                    'uncertain')),-- 当时就没确定
  title          TEXT NOT NULL,   -- 一行摘要（<=30 字），检索展示用
  detail         TEXT NOT NULL,   -- 2~4 句第一人称细节
  person_id      INTEGER REFERENCES person(id),

  event_at       INTEGER NOT NULL,      -- 事情发生时间（解析后）
  event_hint     TEXT,                  -- 原话里的时间词，如「上周三晚上」
  time_precision TEXT NOT NULL DEFAULT 'day'
                 CHECK (time_precision IN ('exact','day','week','month','vague')),
  valid_from     INTEGER,               -- 这条事实的生效/失效区间（fact/preference 用）
  valid_to       INTEGER,

  keywords       TEXT,            -- JSON array，检索主字段
  entities       TEXT,            -- JSON array，人名/项目/物品

  salience       REAL NOT NULL,   -- 编码那一刻的重要性（写一次）
  strength       REAL NOT NULL,   -- 当前强度（衰减/召回改写）
  valence        REAL NOT NULL DEFAULT 0,
  arousal        REAL NOT NULL DEFAULT 0,
  confidence     REAL NOT NULL DEFAULT 1,

  thread_id      INTEGER REFERENCES thread(id),
  episode_id     INTEGER REFERENCES episode(id),
  trace_from     INTEGER,         -- 原始记录的起止 trace.id（含）
  trace_to       INTEGER,
  not_known      TEXT,            -- 我当时没懂也没问的部分
  -- v3：编码时"我注意到什么 / 这对我意味着什么"。以前这两个字段每轮生成、
  -- 每轮被丢弃；现在落库并进提示词，卡片才有"视角"而不只是"摘要"。
  attention      TEXT,
  meant_to_me    TEXT,
  -- v3：状态最后一次变化的时刻，由 refreshStatuses 写，用于避免重复扫描
  status_changed_at INTEGER,

  bg             TEXT,            -- 二元组索引列，由 toBigram() 写入
  created_at     INTEGER NOT NULL,
  decayed_at     INTEGER,
  superseded_by  INTEGER REFERENCES card(id)
);
CREATE INDEX IF NOT EXISTS idx_card_live   ON card(kind, status, strength DESC) WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_card_time   ON card(event_at DESC) WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_card_person ON card(person_id, event_at DESC);
CREATE INDEX IF NOT EXISTS idx_card_thread ON card(thread_id, event_at);
CREATE INDEX IF NOT EXISTS idx_card_episode ON card(episode_id, id DESC) WHERE superseded_by IS NULL;

-- ------------------------------------------------------------
-- 5. 线 Thread —— 来龙去脉
--    同一件事的多次变化串在一起：先 A，后来 B，现在 C。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS thread (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  summary     TEXT,          -- 演变总结（<=3 句），巩固时由便宜模型重写
  card_count  INTEGER NOT NULL DEFAULT 0,
  first_at    INTEGER,
  last_at     INTEGER,
  updated_at  INTEGER,
  summarized_at INTEGER        -- 上次为它写"演变"的时刻；没新卡片就不重写
);

-- ------------------------------------------------------------
-- 6. 未了之事
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS open_loop (
  id              INTEGER PRIMARY KEY,
  created_at      INTEGER NOT NULL,
  text            TEXT NOT NULL,
  due_ts          INTEGER,
  due_hint        TEXT,
  card_id         INTEGER REFERENCES card(id),
  person_id       INTEGER REFERENCES person(id),
  urgency         REAL NOT NULL DEFAULT 0.4,
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','done','dropped','expired')),
  closed_at       INTEGER,
  mentioned_count INTEGER NOT NULL DEFAULT 0,
  -- v3：failed attempts 的明细（JSON 数组，每条是"我上次用的筹码"）。
  -- 它让"同一招加注"这件事可追溯 —— 她不是换招，是在给同一招加价。
  attempts        TEXT,
  escalation      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_loop_open ON open_loop(status, urgency DESC);

-- ------------------------------------------------------------
-- 6b. 卡片之间的声明式关系（v3）
--     为什么必须显式声明：v2 的 thread 是**事后猜**出来的
--     （consolidate.formThreads 用"共享 ≥2 个词元 + 时间接近"做并查集），
--     串错和漏串都很难发现。编码时让模型指着已有卡片的 id 说
--     "因为那张，所以这张"，线就是声明出来的，不是猜出来的。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_link (
  id         INTEGER PRIMARY KEY,
  from_id    INTEGER NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  to_id      INTEGER NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  relation   TEXT NOT NULL CHECK (relation IN ('cause','effect','contradicts','follows','about')),
  created_at INTEGER NOT NULL,
  UNIQUE(from_id, to_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_link_from ON card_link(from_id);
CREATE INDEX IF NOT EXISTS idx_link_to   ON card_link(to_id);

-- ------------------------------------------------------------
-- 6c. 状态迁移日志（v3）
--     status 有两个写入者（appraiser / refreshStatuses），必须能分清
--     一张卡为什么从 active 变成 expired —— 否则调 status 逻辑时无从下手。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_status_log (
  id         INTEGER PRIMARY KEY,
  card_id    INTEGER NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  ts         INTEGER NOT NULL,
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  reason     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_statuslog_ts ON card_status_log(ts);

-- ------------------------------------------------------------
-- 7. 自我叙事（慢变量，版本化）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS self_sheet (
  version    INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  active     INTEGER NOT NULL DEFAULT 0,
  summary    TEXT NOT NULL,
  identity   TEXT NOT NULL,
  core_values TEXT,
  contradictions TEXT,
  voice_rules TEXT,
  long_goals  TEXT,
  change_note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_selfsheet_active
  ON self_sheet(active) WHERE active = 1;

-- ------------------------------------------------------------
-- 8. 动机引擎日志
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS motivation_tick (
  id            INTEGER PRIMARY KEY,
  ts            INTEGER NOT NULL,
  needs         TEXT NOT NULL,
  affect        TEXT NOT NULL,
  chosen_intent TEXT,
  urgency       REAL,
  score         REAL,
  rejected      TEXT,
  card          TEXT
);
CREATE INDEX IF NOT EXISTS idx_tick_time ON motivation_tick(ts);

-- ------------------------------------------------------------
-- 9. 调用日志
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prompt_log (
  id            INTEGER PRIMARY KEY,
  ts            INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  model         TEXT NOT NULL,
  prompt_version TEXT,
  prompt        TEXT,
  response      TEXT,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  cost_usd      REAL,
  latency_ms    INTEGER,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_plog_time ON prompt_log(ts);

-- ------------------------------------------------------------
-- 10. 召回日志 —— 哪张卡片因为什么原因被想起（调权重用）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recall_log (
  id       INTEGER PRIMARY KEY,
  ts       INTEGER NOT NULL,
  turn_id  INTEGER,
  card_id  INTEGER NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  score    REAL NOT NULL,
  channel  TEXT NOT NULL,   -- fts | time | person | thread | loop | recent
  expanded INTEGER NOT NULL DEFAULT 0  -- 是否被翻过原始记录
);
CREATE INDEX IF NOT EXISTS idx_recall_card ON recall_log(card_id, ts);
CREATE INDEX IF NOT EXISTS idx_recall_ts ON recall_log(ts);
CREATE INDEX IF NOT EXISTS idx_plog_ts ON prompt_log(ts);

-- ------------------------------------------------------------
-- 11. 表达审计（v3）—— 确定性校验的记账本
--     为什么要这张表：提示词里那堆"硬约束"（句数、禁语、不复述）以前没人执行，
--     也从来没人知道模型到底遵守了多少。这里每次说话记一行，
--     跑十条对话就能算出"约束遵守率"，不需要 judge 模型、不花钱。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS express_audit (
  id              INTEGER PRIMARY KEY,
  ts              INTEGER NOT NULL,
  turn_id         INTEGER,
  kind            TEXT NOT NULL,          -- reply | proactive
  intent          TEXT,
  sentences       INTEGER NOT NULL DEFAULT 0,
  chars           INTEGER NOT NULL DEFAULT 0,
  max_sentences   INTEGER NOT NULL DEFAULT 0,
  repeat_ratio    REAL NOT NULL DEFAULT 0,
  banned_hits     TEXT,                   -- JSON array
  violations      TEXT,                   -- JSON array of {code,detail}
  retried         INTEGER NOT NULL DEFAULT 0,
  fixed           INTEGER NOT NULL DEFAULT 0, -- 重试后是否修好
  says_nothing    INTEGER NOT NULL DEFAULT 0,
  silence_kind    TEXT,
  breaks_motivation INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON express_audit(ts);

-- ------------------------------------------------------------
-- 全文索引（2-gram + 单字，见 src/store/bigram.ts）
-- ------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS card_fts USING fts5(
  title, detail, keywords, bg,
  content='card', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS trg_card_ai AFTER INSERT ON card BEGIN
  INSERT INTO card_fts(rowid, title, detail, keywords, bg)
    VALUES (new.id, new.title, new.detail, coalesce(new.keywords,''), coalesce(new.bg,''));
END;

CREATE TRIGGER IF NOT EXISTS trg_card_ad AFTER DELETE ON card BEGIN
  INSERT INTO card_fts(card_fts, rowid, title, detail, keywords, bg)
    VALUES ('delete', old.id, old.title, old.detail, coalesce(old.keywords,''), coalesce(old.bg,''));
END;

CREATE TRIGGER IF NOT EXISTS trg_card_au AFTER UPDATE ON card BEGIN
  INSERT INTO card_fts(card_fts, rowid, title, detail, keywords, bg)
    VALUES ('delete', old.id, old.title, old.detail, coalesce(old.keywords,''), coalesce(old.bg,''));
  INSERT INTO card_fts(rowid, title, detail, keywords, bg)
    VALUES (new.id, new.title, new.detail, coalesce(new.keywords,''), coalesce(new.bg,''));
END;

-- ------------------------------------------------------------
-- 视图：当前有效的卡片
-- ------------------------------------------------------------
CREATE VIEW IF NOT EXISTS v_card_live AS
SELECT * FROM card
WHERE superseded_by IS NULL AND strength > 0.05;

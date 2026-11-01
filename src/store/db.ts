/**
 * SQLite 访问层。用 Node 24 内置的 node:sqlite，零原生依赖、不用 node-gyp。
 *
 * 实现要点，按踩坑顺序：
 *   1. DatabaseSync 是同步 API，没有连接池。全应用共用一个连接，
 *      所有写操作都在同一个事件循环里排队，所以仓储层不需要锁。
 *      （这也是 brain.ts 用 promise 队列串行化后台任务的原因之一。）
 *   2. 绑定参数只能用位置占位符 `?`，值限 string / number / bigint / null：
 *      · JS boolean 会直接抛错 → schema 里一律用 INTEGER 0/1；
 *      · 对象/数组自己 JSON.stringify，读回来自己 parse。
 *   3. v2 没有 BLOB 了（向量层已移除）。keywords/entities 这类数组一律 JSON.stringify
 *      存成 TEXT，读的时候 safeJsonArray() 容错解析——别在 SQL 里做 JSON 运算，
 *      SQLite 的 json1 在这套查询里帮不上忙。
 *   4. 事务一律 BEGIN IMMEDIATE：立刻拿写锁。WAL 模式下"先读后升级为写"会撞
 *      SQLITE_BUSY，而本项目所有写点都是"先 SELECT 再 UPDATE"，所以必需。
 *      tx() 不做嵌套/重入检测——别在 tx 里调另一个 tx。
 *   5. applySchema 幂等：schema.sql 全部是 IF NOT EXISTS + INSERT OR IGNORE，
 *      每次开库跑一遍等于"自动建表"。真要改列名/类型时不行，得手写迁移，
 *      并把 meta.schema_version 加一。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.ts";

export type Db = DatabaseSync;
/** node:sqlite 允许的绑定值。缺 boolean 和 object 是刻意的，见文件头第 2 点。 */
export type Param = string | number | null | bigint;

/** 与 db/schema.sql 里的 meta.schema_version 必须一致 */
export const SCHEMA_VERSION = "2";
/**
 * 结构换代的处理：旧库整份改名备份，然后按新结构重建。
 * 不静默删除（记忆是用户的），也不强行迁移（白模阶段没有迁移器）。
 */
function archiveIfOutdated(dbPath: string): void {
  if (!fs.existsSync(dbPath)) return;
  let old: string | undefined;
  try {
    const probe = new DatabaseSync(dbPath);
    try {
      old = (probe.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined)
        ?.value;
    } catch {
      old = undefined;
    }
    probe.close();
  } catch {
    return;
  }
  if (old === SCHEMA_VERSION) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${dbPath}.v${old ?? "0"}-${stamp}.bak`;
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(dbPath + suffix)) fs.renameSync(dbPath + suffix, backup + suffix);
  }
  console.warn(
    `[db] 记忆库是 v${old ?? "?"} 结构，schema 已升到 v${SCHEMA_VERSION}：` +
      `旧库原样备份为 ${path.basename(backup)}，本次按新结构重建。`,
  );
}

export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  archiveIfOutdated(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 3000;");
  applySchema(db);
  return db;
}

export function applySchema(db: Db): void {
  const sql = fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf8");
  db.exec(sql);
  // 加列迁移：CREATE TABLE IF NOT EXISTS 不会给旧表补列，所以新列要单独补。
  // 只做"加列"，改类型/改名仍然要走备份重建（见 archiveIfOutdated）。
  //
  // ★ 这里是 v3 的增量。列表只许变长，不许改签名 —— 每加一个，同时确认
  //   schema.sql 里新建的库也有这一列，否则新旧两个库的列集合会分叉。
  ensureColumn(db, "thread", "summarized_at", "INTEGER");
  ensureColumn(db, "card", "attention", "TEXT");
  ensureColumn(db, "card", "meant_to_me", "TEXT");
  ensureColumn(db, "card", "status_changed_at", "INTEGER");
  ensureColumn(db, "open_loop", "attempts", "TEXT");
  ensureColumn(db, "open_loop", "escalation", "INTEGER NOT NULL DEFAULT 0");
  // v4：人物档案。老库里已有的那个人会被补成 dossier_status='known'，
  // display_name 留空（由 loadPersona 之后的第一次解析去填）。
  ensureColumn(db, "person", "dossier_status", "TEXT NOT NULL DEFAULT 'known'");
  ensureColumn(db, "person", "display_name", "TEXT");
  ensureColumn(db, "person", "self_intro_at", "INTEGER");
  ensureColumn(db, "person", "asked_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "person", "last_asked_at", "INTEGER");
  ensureColumn(db, "person", "traits", "TEXT");
  ensureColumn(db, "person", "open_questions", "TEXT");
  // 让 SQLite 自己决定要不要重建统计信息；对高频读的表是免费的加速
  db.exec("PRAGMA optimize;");
}

/** 幂等加列。列已存在时什么也不做。 */
function ensureColumn(db: Db, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

export function all<T>(db: Db, sql: string, params: Param[] = []): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function get<T>(db: Db, sql: string, params: Param[] = []): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

export function run(db: Db, sql: string, params: Param[] = []): void {
  db.prepare(sql).run(...params);
}

/** 事务：抛错自动回滚。不做嵌套（本项目不需要）。 */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 已回滚 */
    }
    throw e;
  }
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = get<{ value: string }>(db, "SELECT value FROM meta WHERE key = ?", [key]);
  return row?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  run(db, "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
    key,
    value,
  ]);
}

export function getMetaJson<T>(db: Db, key: string): T | undefined {
  const raw = getMeta(db, key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function setMetaJson(db: Db, key: string, value: unknown): void {
  setMeta(db, key, JSON.stringify(value));
}

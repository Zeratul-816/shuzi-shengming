/**
 * 装配层：把 config / db / LLM / 已编译人设 绑成 Env 传下去。
 * 全项目只有这里 new 这些对象，模块之间靠 Env 注入（测试也因此可以只换 dbPath）。
 *
 * v2 去掉了向量索引：没有"常驻模型"要加载，启动就是开库 + 编译人设，毫秒级。
 *
 * 顺序有依赖：
 *   1. loadConfig()  —— 先读 .env / key 文件
 *   2. openDb()      —— 建表（幂等）+ 结构换代时自动备份旧库
 *   3. seedPersona() —— 人设编译落库，保证 Env 一建好就有一版自我叙事
 *   4. loadPersona() —— 读 persona/ 三个文件，生成跨轮不变的 system 提示词
 */
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import type { Db } from "./store/db.ts";
import { openDb } from "./store/db.ts";
import type { Provider } from "./llm/provider.ts";
import { createProvider } from "./llm/provider.ts";
import type { CompiledPersona } from "./express/persona.ts";
import { loadPersona, seedPersona } from "./express/persona.ts";

export interface Env {
  cfg: Config;
  db: Db;
  llm: Provider;
  persona: CompiledPersona;
  close(): void;
}

export function createEnv(overrides: Partial<Config> = {}): Env {
  const cfg = loadConfig(overrides);
  const db = openDb(cfg.dbPath);
  seedPersona(db, Date.now());
  return {
    cfg,
    db,
    llm: createProvider(cfg),
    persona: loadPersona(),
    close() {
      // 把 WAL 收回去：长期运行的助手不该留下几百 MB 的 -wal 文件
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        /* 收不回去也不影响正确性 */
      }
      db.close();
    },
  };
}

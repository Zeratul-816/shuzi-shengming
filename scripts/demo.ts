/**
 * 离线 demo：用 mock 提供方把「编码 → 卡片 → 结构化召回 → 动机 → 表达」跑一遍。
 * 不花钱，用来验证管道和看数据流。真实使用请设 DH_PROVIDER=openai|anthropic。
 *
 *   npm run demo
 *
 * ── 这个脚本在演示什么 ─────────────────────────────────────
 *   ① 六轮对话   每轮：动机卡 → 召回 → 表达 →（后台）写卡片
 *   ② 时间通道   用「昨天」「上周」之类的问法试探召回
 *   ③ 两段式     对某张卡片翻原始记录（/expand 的同款能力）
 *   ④ 巩固       合并重复 + 把同主题卡片串成线 + 写"演变"
 *
 * mock 写出的卡片是 "他跟我说：<原句>" 这种桩文本，只证明管道通，
 * 不证明记忆像人。后者要接真模型看 appraise.system.md 的效果。
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.ts";
import { createEnv } from "../src/env.ts";
import { Brain } from "../src/brain.ts";
import { consolidate } from "../src/memory/consolidate.ts";
import { expandCard } from "../src/memory/retrieve.ts";
import { liveCards } from "../src/store/repos.ts";
import { needsTable } from "../src/motivation/tick.ts";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

const dataDir = path.join(ROOT, "data");
const dbPath = path.join(dataDir, "demo.db");
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });

const env = createEnv({ dbPath, dataDir, provider: "mock" });
const brain = new Brain(env);

const SCRIPT = [
  "今天上线，救火救了五个小时，现在脑子是糊的。",
  "我养的那只猫叫豆豆，昨天趁我开门跑了。",
  "找回来了，凌晨三点在楼下花坛里蹲着，一身土。",
  "现在特别困，但躺下就清醒。",
  "你还记得我说的那个报错吗？",
  "算了，我先去睡。",
];

console.log(`\n${C.bold("数字生命 · 离线 demo（卡片制，无向量）")}  ${C.dim("（mock 提供方，零成本）")}\n`);
console.log(C.dim(`记忆库：${dbPath}\n`));

for (const text of SCRIPT) {
  await brain.settle();
  console.log(`${C.cyan("你")} ▸ ${text}`);
  const r = await brain.turn(text);
  console.log(`${C.dim("我")} ▸ ${r.saysNothing ? "（没说话）" : r.speech}`);
  await brain.settle();
  console.log(
    C.dim(
      `     ↳ 意图=${r.card.intent} 召回=${r.recalled.length} 张 当前卡片=${liveCards(env.db, 100).length} 张`,
    ),
  );
  console.log();
}

// ── 主动发言：迟滞与沉默 ──
console.log(C.bold("── 主动动机演示 ──"));
const s = brain.stats().state;
s.needs.expression = 0.78;
s.needs.connection = 0.05;
s.needs.curiosity = 0.05;
s.needs.competence = 0.05;
s.needs.autonomy = 0.05;
s.needs.rest = 0.05;
s.lastProactiveAt = 0;
s.updatedAt = Date.now();

const first = await brain.proactive();
console.log(`${C.yellow("第 1 拍")}  ${first ? "开口了" : "沉默（迟滞：还没连续两拍领先）"}`);
const second = await brain.proactive();
if (second) console.log(`${C.magenta("第 2 拍 我（主动）")} ▸ ${second.speech}`);
await brain.settle();
console.log();

// ── 巩固：合并 + 串线 ──
console.log(C.bold("── 巩固（合并 / 串线 / 写演变）──"));
const rep = await consolidate(env, Date.now());
console.log(
  C.dim(
    `  卡片 ${rep.liveBefore} → ${rep.liveAfter} 张 · 字面合并 ${rep.merged} 组 · 模型判定 ${rep.llmMerged} 组`,
  ),
);
console.log(C.dim(`  串线 ${rep.threadsFormed} 条 · 重写演变 ${rep.threadsSummarized} 条`));
for (const n of rep.notes) console.log(C.dim(`  · ${n}`));
console.log();

// ── 现在的卡片长什么样 ──
console.log(C.bold("── 现在的卡片 ──"));
for (const c of liveCards(env.db, 30)) {
  const kw = JSON.parse(c.keywords ?? "[]").join("/");
  console.log(
    `  ${C.dim(`#${String(c.id).padEnd(3)}`)} ${C.dim(`[${c.kind}/${c.status}]`)} ${c.title}  ` +
      C.dim(`${kw ? `⟨${kw}⟩ ` : ""}强度${c.strength.toFixed(2)}${c.thread_id ? ` 线#${c.thread_id}` : ""}`),
  );
}
console.log();

// ── 结构化召回探针 ──
console.log(C.bold("── 召回探针（看通道，不看相似度）──"));
for (const q of ["猫找到了吗", "线上那个报错", "昨天的事", "他现在困不困"]) {
  const hits = await brain.recallProbe(q);
  console.log(`  ${C.green("?")} ${q}`);
  if (hits.length === 0) console.log(C.dim("      （没想起来）"));
  for (const h of hits.slice(0, 3)) {
    console.log(
      C.dim(`      ${h.score.toFixed(3)} [${h.channel}] ${h.time_label} ${h.title}${h.fromThread ? " ↳前后变化" : ""}`),
    );
  }
}
console.log();

// ── 两段式：翻原始记录 ──
console.log(C.bold("── 翻原始记录（两段式的第二段）──"));
const sample = liveCards(env.db, 1)[0];
if (sample) {
  const slice = expandCard(env, sample.id, 4);
  console.log(`  卡片 #${sample.id}：${sample.title}`);
  if (slice) for (const l of slice.lines) console.log(C.dim(`    ${l.role === "user" ? "他" : "我"}：${l.content}`));
  else console.log(C.dim("    （这张卡片没有可翻的原始记录）"));
}
console.log();

// ── 状态 ──
console.log(C.bold("── 需求 ──"));
console.log(needsTable(brain.stats().state.needs));
console.log();

await brain.settle();
env.close();
console.log(C.dim("demo 结束。真实对话：双击 启动.cmd\n"));

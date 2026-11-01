/**
 * 人设编译。把 persona/ 下的三个文件编译成两个产物：跨轮不变的 system 提示词，
 * 和一条可演进的"当前自我认识"。
 *
 * ── 三个输入文件，去向不同 ────────────────────────────────
 *   identity.md    人格内核 → 直接拼进 system（每轮都发，靠 prompt cache 摊平成本）
 *   voice.json     说话契约 → 渲染进 express.rules 模板，也在 system
 *   seed-self.md   自我叙事的**种子** → 写进 self_sheet.summary（进 user 慢变区）
 *   为什么后两者分开：identity 是"我是什么"（不该变），summary 是"我现在怎么看待自己"
 *   （应该被巩固任务越写越厚）。混在一起会导致每次巩固都在改写人格内核。
 *
 * ── 这个文件最容易出事，所以校验写得很啰嗦 ────────────────
 *   人设是手写的，手写 JSON 的翻车方式就那么几种：末尾多逗号、用了中文引号、
 *   写成字符串而不是数组、存成 UTF-16、BOM 没去掉。
 *   这些都不该表现为一屏 SyntaxError 堆栈——用户只需要知道"哪个文件、第几行、怎么改"。
 *   所以：读 → 去 BOM → 解析 → 结构校验，每一步失败都抛 PersonaError 并带可执行提示。
 *
 * ── hash 的用途 ──────────────────────────────────────────
 *   system 全文的 sha1 前 12 位：/reseed 后一眼看出人格是否真的换了；
 *   prompt_log.prompt_version 记这个值，回放历史提示词时能分清"是模型的问题还是我改了人设"。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { ROOT } from "../config.ts";
import type { Db } from "../store/db.ts";
import { get } from "../store/db.ts";
import { activeSelfSheet, insertSelfSheet } from "../store/repos.ts";
import { bullet, loadPrompt, numbered, render } from "./templates.ts";

/**
 * 人设目录。默认 persona/，可用 DH_PERSONA_DIR 指向别处 ——
 * 这样既能做人格 A/B（两个目录切换），也让"人设写错时报什么错"能被单测覆盖。
 */
function personaDir(): string {
  const custom = process.env.DH_PERSONA_DIR;
  return custom ? path.resolve(custom) : path.join(ROOT, "persona");
}

/** 人设文件的问题。message 给人看，hint 是可执行的下一步。 */
export class PersonaError extends Error {
  readonly hint: string;
  constructor(message: string, hint = "") {
    super(message);
    this.name = "PersonaError";
    this.hint = hint;
  }
}

/** 允许写一个字符串代替单元素数组（"positive": "别啰嗦"），其余原样交给 zod */
const stringList = z.preprocess(
  (v) => (v === undefined || v === null ? [] : typeof v === "string" ? [v] : v),
  z.array(z.string()),
);

const VoiceSchema = z
  .object({
    positive: stringList,
    negative: stringList,
    banned_phrases: stringList,
    examples_good: stringList,
    examples_bad: stringList,
  })
  // 允许 _说明 这类自定义键：json 是给人看的，多写注释字段不该报错
  .passthrough();

export type VoiceContract = z.infer<typeof VoiceSchema>;

export interface CompiledPersona {
  identity: string;
  voice: VoiceContract;
  /** 「我」的称呼（persona/self.json）。用途只有一个：知道他在叫我。**不**用来阻挡误会。 */
  selfNames: string[];
  /** 表达层的 system 提示词：人设 + 说话契约 + 输出格式（跨轮不变 → 命中 prompt cache） */
  system: string;
  hash: string;
}

/** 去掉记事本/PowerShell 常留的 UTF-8 BOM，否则 JSON.parse 必挂 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 找出"数组/对象最后一项后面多写的逗号"，返回行号（1 起） */
function findTrailingCommas(text: string): number[] {
  const lines: number[] = [];
  const re = /,\s*[}\]]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    lines.push(text.slice(0, m.index).split("\n").length);
  }
  return lines;
}

/**
 * 文件不存在时，顺手在 persona/ 的子目录里找同名备份。
 * 场景：有人想同时保有两份人设，把旧的放进 persona/某个子目录/，然后删了根目录那份。
 * 这里只用来**指路**（报错里告诉他备份在哪），不自动加载 —— 自动挑人设会让人困惑。
 */
function findBackup(base: string): string | null {
  try {
    for (const e of fs.readdirSync(personaDir(), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(personaDir(), e.name, base);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* 目录都读不了就走正常报错 */
  }
  return null;
}

function readText(file: string, label: string): string {
  if (!fs.existsSync(file)) {
    const backup = findBackup(path.basename(file));
    throw new PersonaError(
      `找不到${label}：${path.relative(ROOT, file)}`,
      backup
        ? `备份目录里有一份：${path.relative(ROOT, backup)}\n    复制回 ${path.relative(ROOT, file)} 即可。`
        : `新建一个 ${path.relative(ROOT, file)} 再启动。`,
    );
  }
  const raw = stripBom(fs.readFileSync(file, "utf8"));
  if (raw.trim() === "") {
    throw new PersonaError(`${label}是空文件：${path.relative(ROOT, file)}`, "至少写一行内容再启动。");
  }
  return raw;
}

function readVoice(file: string): VoiceContract {
  const raw = readText(file, "说话契约 voice.json");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const badLines = findTrailingCommas(raw);
    const where = /line (\d+) column (\d+)/.exec(msg);

    if (badLines.length > 0) {
      throw new PersonaError(
        `persona/voice.json 不是合法 JSON：第 ${badLines.join("、")} 行的最后一项后面多了逗号`,
        "JSON 不允许数组/对象的最后一项带逗号。删掉紧跟在 ] 或 } 前面的那个逗号即可。",
      );
    }
    throw new PersonaError(
      `persona/voice.json 不是合法 JSON${where ? `（第 ${where[1]} 行第 ${where[2]} 列）` : ""}：${msg.split("\n")[0]}`,
      "常见原因：末尾多逗号、用了中文引号“ ”、写了 // 注释。\n" +
        '    单独验证：node -e "JSON.parse(require(\'fs\').readFileSync(\'persona/voice.json\',\'utf8\'))"',
    );
  }

  const checked = VoiceSchema.safeParse(parsed);
  if (!checked.success) {
    const issues = checked.error.issues.map((i) => `  · ${i.path.join(".") || "(根)"}：${i.message}`).join("\n");
    throw new PersonaError(
      `persona/voice.json 结构不对：\n${issues}`,
      "每个字段都应该是字符串数组，例如：\n" +
        '    "positive": ["默认一到三句，说完就停。", "不确定就说不确定。"]\n' +
        "    （写单个字符串也行，会被自动包成数组）",
    );
  }
  return checked.data;
}

/**
 * 「我」的称呼。**可以是空文件/不存在**。
 *
 * 唯一的用途：知道他在叫我（记进 `awakening.called_as`，并给编码器一个提示）。
 * 它**不**用来挡"有人拿我的名字当名字"——那种误会允许发生，见 memory/person.ts。
 */
function readSelfNames(dir: string): string[] {
  const file = path.join(dir, "self.json");
  if (!fs.existsSync(file)) return [];
  const raw = stripBom(fs.readFileSync(file, "utf8")).trim();
  if (raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new PersonaError(
      `persona/self.json 不是合法 JSON：${msg.split("\n")[0]}`,
      '形状：{ "names": ["艾拉", "E.L.A"] }',
    );
  }
  const checked = z.object({ names: z.array(z.string().min(1)).default([]), note: z.string().optional() }).safeParse(parsed);
  if (!checked.success) {
    throw new PersonaError(
      `persona/self.json 结构不对：${checked.error.issues.map((i) => i.path.join(".")).join("、")}`,
      '形状：{ "names": ["艾拉", "E.L.A"] }',
    );
  }
  return checked.data.names.map((s) => s.trim()).filter(Boolean);
}

export function loadPersona(): CompiledPersona {
  const dir = personaDir();
  if (!fs.existsSync(dir)) {
    throw new PersonaError(
      `persona/ 目录不存在：${dir}`,
      "重建这三个必需文件：\n" +
        "    identity.md / voice.json / seed-self.md\n" +
        "    （self.json 可选：缺了就等于没配自己的名字）",
    );
  }

  const identity = readText(path.join(dir, "identity.md"), "人设正文 identity.md").trim();
  const voice = readVoice(path.join(dir, "voice.json"));
  const selfNames = readSelfNames(dir);

  const rules = render(loadPrompt("express.rules"), {
    NEGATIVE: numbered(voice.negative),
    POSITIVE: numbered(voice.positive),
    BANNED: bullet(voice.banned_phrases),
    GOOD_EXAMPLES: bullet(voice.examples_good),
    BAD_EXAMPLES: bullet(voice.examples_bad),
  });

  const system = `${identity}\n\n${rules}`;
  const hash = crypto.createHash("sha1").update(system).digest("hex").slice(0, 12);
  return { identity, voice, selfNames, system, hash };
}

/**
 * 当前自我叙事的种子。
 * 刻意与人设正文分开：identity.md 是"人格内核"（进 system，跨轮不变），
 * seed-self.md 是"我现在的自我认识"（进 user 慢变区，会被巩固任务改写）。
 */
function seedSummary(identity: string): string {
  const seedFile = path.join(personaDir(), "seed-self.md");
  if (fs.existsSync(seedFile)) {
    const raw = stripBom(fs.readFileSync(seedFile, "utf8"));
    const body = raw
      .split("\n")
      .filter((l) => !l.trim().startsWith("（"))
      .join("\n")
      .trim();
    if (body) return body.slice(0, 300);
  }
  return identity
    .split("\n")
    .filter((l) => !l.startsWith("#") && !l.startsWith("*") && l.trim() !== "")
    .join("\n")
    .slice(0, 300);
}

/**
 * 人设编译落库：第一次启动时把 persona/ 编译成 self_sheet v1。
 * 之后 self_sheet 由巩固任务演进，persona/ 只作为初始种子与"硬骨头"。
 */
export function seedPersona(
  db: Db,
  now: number,
  opts: { force?: boolean } = {},
): { seeded: boolean; version: number } {
  // force = /reseed 用：即使已有生效版本也重编一版。
  // 不带 force 时是启动路径，必须幂等——每次启动都插一版会把 self_sheet 撑爆。
  if (!opts.force) {
    const existing = activeSelfSheet(db);
    if (existing) return { seeded: false, version: existing.version };
  }

  const p = loadPersona(); // 先编译：人设有问题就在启动时炸，别带着坏人设跑

  // 版本号必须取 MAX(version)+1，不能写死 1。
  // 踩过的坑：/reseed 时库里已经有 v1，硬编码 1 直接撞 self_sheet 的主键，
  // 而且 CLI 那一步已经把旧版 active 置 0 了 → 库里变成"一行都不生效"，
  // 下次启动同样撞主键，应用彻底起不来。
  const maxVersion = get<{ v: number | null }>(db, "SELECT MAX(version) AS v FROM self_sheet")?.v ?? 0;
  insertSelfSheet(db, {
    version: maxVersion + 1,
    created_at: now,
    summary: seedSummary(p.identity),
    identity: p.identity,
    core_values: JSON.stringify(["听懂", "记得", "不装"]),
    contradictions: JSON.stringify(["想被需要 / 想保有自己", "想帮忙 / 不想变成客服"]),
    voice_rules: JSON.stringify(p.voice),
    long_goals: JSON.stringify([]),
    change_note: `从 persona/ 编译（${p.hash}）`,
  });
  return { seeded: true, version: maxVersion + 1 };
}

/** 人设与库里的 self_sheet 不一致时提示（决定是否要 bump 版本） */
export function personaDrift(db: Db): {
  stale: boolean;
  activeVersion: number;
  personaHash: string;
  note: string | null;
} {
  const cur = activeSelfSheet(db);
  const p = loadPersona();
  if (!cur) return { stale: true, activeVersion: 0, personaHash: p.hash, note: null };
  const note = cur.change_note ?? "";
  return { stale: !note.includes(p.hash), activeVersion: cur.version, personaHash: p.hash, note };
}

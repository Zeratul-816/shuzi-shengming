/**
 * 配置。优先级：真实环境变量 > .env > 代码默认值。
 *
 * 为什么自己写 .env 解析而不是用 --env-file-if-exists：
 *   那个 flag 在文件不存在时会往 stderr 打一行提示，npm/PowerShell 会把它当成
 *   命令失败（NativeCommandError），每次都刷一屏红色，很吵。二十行解析换清静。
 *
 * 默认值的选择逻辑：默认 DH_PROVIDER=mock，让"clone 下来直接 npm start"能跑通，
 * 不需要 key。这是刻意的：先验证管道，再接模型，避免一上手就在调 401。
 *
 * 注意 baseUrl 的含义随 provider 变：
 *   openai    → 拼 /chat/completions，所以带不带尾斜杠都行（已 trim）
 *   anthropic → 拼 /v1/messages，所以 baseUrl 应该是 https://api.anthropic.com
 * 换端点时最容易错的就是这个斜杠和版本段。
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * 极简 .env 加载：不引 dotenv，也不依赖 --env-file（那个 flag 在文件不存在时
 * 会往 stderr 吐一行提示，在 npm 下会被当成错误输出）。
 * 已存在的环境变量优先，不覆盖。
 */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, ".env"));

export type ProviderName = "mock" | "openai" | "anthropic";


export interface Config {
  dataDir: string;
  dbPath: string;
  provider: ProviderName;
  baseUrl: string;
  apiKey: string;
  /** key 是从哪个文件读到的（只用于横幅提示，绝不进日志、绝不打印明文） */
  keySource: string | null;
  /** key 文件落在版本库目录里，有被提交的风险 */
  keyRisky: boolean;
  expressModel: string;
  appraiseModel: string;
  tickMs: number;
  /**
   * 召回参数。v2 全是结构化检索，没有向量，所以这里没有 topK of vectors，
   * 只有"铺多宽"和"带几条进提示词"。
   */
  recall: {
    ftsTopK: number; // 关键词通道取多少候选
    maxCards: number; // 最终进提示词的卡片数上限
    maxTokens: number; // 卡片骨架的 token 预算
    threadSiblings: number; // 每张命中卡片最多带出几条"前后变化"
    linkNeighbors: number; // 每轮最多带出几张"声明过因果"的邻居
    recentWindowMs: number; // "最近"通道的时间跨度
    maxExpandCards: number; // 允许模型要多少次原话
    expandLines: number; // 每次展开取几行原始记录
    serendipityChance: number; // 反刍通道的触发概率（0 = 关）
  };
  resumeGapMs: number; // 超过这么久没说话，就算新 episode
}

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

// ── API key 的发现顺序 ─────────────────────────────────────
// 开发期不想把 key 写进仓库，所以允许"就近放一个文件"。
// 真实环境变量 > .env（在上面已经加载） > 显式 DH_API_KEY_FILE > 约定位置。
const KEY_FILE_CANDIDATES = (): { file: string; label: string; risky?: boolean }[] => {
  const home = os.homedir();
  return [
    { file: path.join(home, ".deepseek_api_key"), label: "~/.deepseek_api_key" },
    { file: path.join(home, ".deepseek.key"), label: "~/.deepseek.key" },
    { file: path.join(home, "deepseek_api_key.txt"), label: "~/deepseek_api_key.txt" },
    { file: path.join(home, "api-key.txt"), label: "~/api-key.txt" },
    { file: path.join(home, ".api-key"), label: "~/.api-key" },
    { file: path.join(ROOT, ".api-key"), label: ".api-key（项目根）" },
    { file: path.join(ROOT, "api-key.txt"), label: "api-key.txt（项目根）" },
    // 兜底：有人会顺手把 key 丢进 src/。能读，但要标红——这个位置容易被提交。
    { file: path.join(ROOT, "src", "api-key.txt"), label: "src/api-key.txt", risky: true },
  ];
};

/**
 * 读取 key 文件。容忍三种写法，因为不同工具存 key 的习惯不一样：
 *   sk-xxxxxxxx                       （裸 key）
 *   DH_API_KEY=sk-xxxxxxxx            （dotenv 行）
 *   export DEEPSEEK_API_KEY=sk-xxxx   （shell 行）
 * 返回 null 表示文件不存在或里面没有像 key 的东西。
 */
export function readKeyFile(file: string): string | null {
  let raw: string;
  try {
    if (!fs.existsSync(file)) return null;
    raw = fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
  if (!raw) return null;

  const bare = /^sk-[A-Za-z0-9_-]{10,}$/.exec(raw);
  if (bare) return bare[0];

  const kv = /(?:^|\n)\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*["']?([^"'\r\n#]+)/.exec(raw);
  if (kv && kv[1].trim()) return kv[1].trim();

  const any = /sk-[A-Za-z0-9_-]{10,}/.exec(raw);
  return any ? any[0] : null;
}

export function resolveApiKey(): { key: string; label: string; risky: boolean } | null {
  const explicit = process.env.DH_API_KEY_FILE;
  const list = KEY_FILE_CANDIDATES();
  const candidates = explicit ? [{ file: explicit, label: explicit, risky: false }, ...list] : list;
  for (const c of candidates) {
    const key = readKeyFile(c.file);
    if (key) return { key, label: c.label, risky: c.risky === true };
  }
  return null;
}

/** 把 key 打成 sk-****abcd，只用于给人看"读到了哪一把" */
export function maskKey(key: string): string {
  if (!key) return "(空)";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = env("DH_DATA_DIR", path.join(ROOT, "data"));
  fs.mkdirSync(dataDir, { recursive: true });

  const found = resolveApiKey();
  // provider 的默认值：显式设了就听，否则"能找到 key 就走真实模型"，找不到就 mock。
  // 这样 clone 下来能直接跑（不花钱），放了 key 就自动切到 DeepSeek，不需要改任何配置。
  const explicitProvider = env("DH_PROVIDER");
  const provider: ProviderName = explicitProvider
    ? (explicitProvider as ProviderName)
    : found
      ? "openai"
      : "mock";
  const isMock = provider === "mock";

  const apiKey = env("DH_API_KEY", isMock ? "mock" : (found?.key ?? ""));
  const baseUrl = env("DH_BASE_URL", isMock ? "http://mock.local" : "https://api.deepseek.com/v1");

  const cfg: Config = {
    dataDir,
    dbPath: env("DH_DB_PATH", path.join(dataDir, "memory.db")),
    provider,
    baseUrl,
    apiKey,
    keySource: found?.label ?? null,
    keyRisky: found?.risky ?? false,
    expressModel: env("DH_EXPRESS_MODEL", "deepseek-chat"),
    appraiseModel: env("DH_APPRAISE_MODEL", "deepseek-chat"),
    tickMs: Number(env("DH_TICK_MS", "30000")),
    recall: {
      ftsTopK: 40,
      maxCards: 8,
      maxTokens: 900,
      threadSiblings: 2,
      linkNeighbors: 2,
      recentWindowMs: 3 * 86_400_000,
      maxExpandCards: 2,
      expandLines: 8,
      // 反刍：每轮 12% 的概率塞一张"跟话题无关但当时很重要"的旧卡。
      // 调 0 就关掉（评测里应该关，否则结果不可复现）。
      serendipityChance: Number(env("DH_SERENDIPITY", "0.12")),
    },
    resumeGapMs: 30 * 60 * 1000,
    ...overrides,
  };

  if (!isMock && !cfg.apiKey) {
    // 不阻断启动，只在启动横幅里提示；mock 兜底由调用方决定
    process.emitWarning("DH_API_KEY 为空，真实模型调用会失败，建议先设 DH_PROVIDER=mock 验证管道");
  }
  return cfg;
}

/** 粗估 token：中文 1 字≈1 token，英文 4 字符≈1 token。够用，不引 tokenizer。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3400-\u9fff\u3040-\u30ff\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 3.5);
}

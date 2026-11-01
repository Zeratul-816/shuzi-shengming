/**
 * 中文全文检索的分词器。全系统唯一的切词入口——写入（atom.bg）和查询
 * （searchFts）必须调用同一个函数，否则索引和查询对不上，表现为"明明有这条却搜不到"。
 *
 * 策略：2-gram 滑窗 + 单字兜底。
 *
 * 为什么不用 fts5 的 trigram 分词器：它只建 3 字滑窗，
 * 「上线」「心疼」「没睡」这类 2 字词一律召回 0 —— 而中文记忆里
 * 2 字词恰恰是最常见的检索单位。（已实测，见 docs 附录 A）
 *
 * 为什么还要单字：光有二元组时「找回来了」和「找到」没有共同词元，
 * 「猫找到了吗」会漏掉「猫跑丢了」。单字（去掉高频虚字）兜住这种模糊匹配，
 * 精度交给向量通道。
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;

/** 单字索引里剔除的高频虚字：它们几乎不携带检索信息，只会稀释 bm25 */
const STOP_CHARS = new Set(
  "的了在是我你他她它吗呢吧啊和就都也很不这那有个上下来去说着过把被给让对还又但却".split(""),
);

function cjkTokens(run: string): string[] {
  const out: string[] = [];
  if (run.length === 0) return out;
  if (run.length === 1) {
    if (!STOP_CHARS.has(run)) out.push(run);
    return out;
  }
  for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  for (const ch of run) if (!STOP_CHARS.has(ch)) out.push(ch);
  return out;
}

/** 汉字：二元组 + 单字；ASCII/数字：整词小写；标点与空白当分隔符 */
export function toBigram(input: string): string {
  const out: string[] = [];
  let cjkRun = "";
  let word = "";

  const flushCjk = () => {
    if (cjkRun) out.push(...cjkTokens(cjkRun));
    cjkRun = "";
  };
  const flushWord = () => {
    if (word) out.push(word);
    word = "";
  };

  for (const ch of input) {
    if (CJK.test(ch)) {
      flushWord();
      cjkRun += ch;
    } else if (/[A-Za-z0-9]/.test(ch)) {
      flushCjk();
      word += ch.toLowerCase();
    } else {
      flushCjk();
      flushWord();
    }
  }
  flushCjk();
  flushWord();
  return out.join(" ");
}

/**
 * 两个字串的「二元组 Dice 系数」= 2|A∩B| / (|A|+|B|)，只用二元组（单字噪声太大）。
 *
 * 用途：判重的第二道闸门。向量余弦在两种情况下不可靠：
 *   1. v2 已经没有向量层了，字面重合度是**唯一**不花 LLM 钱的自动判重手段；
 *   2. 中文短句里，同一件事的两种措辞很难靠别的办法对齐。
 * Dice 补的正是这一类：同一件事的两种措辞，字面重合度通常在 0.65~0.9。
 *
 * 实测标定（真实模型写出的记忆对）：
 *   同义改写 0.703 / 原句重复 1.000 / 不同事 0.044 / 无关 0.000
 * 分得很开，所以 0.62 做去重、0.45 做联想边都相当安全。
 */
export function bigramDice(a: string, b: string): number {
  const toSet = (s: string) =>
    new Set(
      toBigram(s)
        .split(" ")
        .filter((t) => t.length >= 2),
    );
  const A = toSet(a);
  const B = toSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** 预先切好词元再反复比时用，避免同一句重复调用 toBigram */
export function bigramSet(s: string): Set<string> {
  return new Set(
    toBigram(s)
      .split(" ")
      .filter((t) => t.length >= 2),
  );
}

export function diceOfSets(A: Set<string>, B: Set<string>): number {
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of small) if (big.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/**
 * 查询侧：OR 连接。
 * 用 AND 会太严——「猫找到了吗」要求同时含「猫找/找到/到了/了吗」，
 * 一句同义改写就全军覆没。OR 交给 bm25 排序，精度由向量通道补。
 */
export function toFtsQuery(input: string): string {
  const tokens = [...new Set(toBigram(input).split(" ").filter(Boolean))];
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

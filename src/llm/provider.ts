/**
 * 模型层。三个实现 + 一个"要 JSON 就带校验重试"的壳，不用任何厂商 SDK。
 *
 * v2 移除：嵌入接口。
 *   记忆检索改成结构化（时间/人物/关键词/状态），不再需要把文本塞进向量空间。
 *   于是这一层只剩 chat —— 更少的接口、更少的失败模式、更少的开销。
 *
 * 为什么不引 SDK：只需要 chat/completions 一个接口，手写 fetch 反而更容易接
 * 任何兼容端点（DeepSeek / Kimi / Qwen / Ollama / 各种网关），也少一层版本地狱。
 *
 * 两个模型档位：
 *   kind = "express" → cfg.expressModel（强、贵、temperature 0.8）
 *   kind = 其他       → cfg.appraiseModel（便宜、快、temperature 0.2）
 * 强烈建议两者用不同厂商：同一模型既写记忆又表演，会系统性地美化自己。
 *
 * chatJson() 是唯一入口纪律：调模型 → 剥围栏 → zod 校验 → 失败把错误回灌重试一次
 * → 再失败抛错。不能兜底成默认值，否则"因为解析失败而记错了一件事"会静默进库。
 */
import type { Config, ProviderName } from "../config.ts";
import { estimateTokens } from "../config.ts";
import type { z } from "zod";

export type CallKind = "express" | "appraise" | "plan" | "consolidate" | "judge";

export interface ChatOptions {
  kind: CallKind;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  json?: { name: string; schema: unknown };
  timeoutMs?: number;
  /** 仅供 mock 提供方使用的调试信息（真实模型看不到） */
  hint?: unknown;
}

export interface ChatResult {
  text: string;
  model: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

export interface Provider {
  name: string;
  chat(o: ChatOptions): Promise<ChatResult>;
}

// ── JSON 抽取：模型爱在 JSON 外面裹 Markdown 围栏 ─────────────
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("输出里没有 JSON 对象");
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * 调模型并要求通过 zod 校验；失败重试一次（把校验错误回灌给它）。
 *
 * 为什么签名是 `S extends z.ZodTypeAny` 而不是 `z.ZodType<T>`：
 *   zod 的 ZodType 是 `ZodType<Output, Def, Input>` 三参数。写成 `z.ZodType<T>` 时
 *   Input 会被默认成 T，于是 TypeScript 从**输入**和**输出**两个位置同时推 T，
 *   凡是带 `.default()` 的 schema 都会被推成"输入类型"（字段全 optional）。
 *   这个 bug 在 `node --test` 下完全不可见（Node 只剥类型），是接上 tsc 之后
 *   一次报出 5 个错才发现的。用 z.output<S> 取真正的输出类型。
 */
export async function chatJson<S extends z.ZodTypeAny>(
  provider: Provider,
  opts: ChatOptions,
  schema: S,
  retries = 1,
): Promise<{ value: z.output<S>; raw: ChatResult }> {
  let lastErr: unknown;
  let user = opts.user;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await provider.chat({ ...opts, user });
    try {
      const parsed = parseJsonLoose(raw.text);
      const value = schema.parse(parsed);
      return { value, raw };
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      user =
        opts.user +
        `\n\n[系统] 上一次输出无法解析：${msg.slice(0, 300)}\n只输出一个符合 schema 的 JSON 对象，不要任何解释、不要 Markdown 围栏。`;
    }
  }
  throw new Error(`模型输出不合 schema（重试 ${retries} 次后）：${String(lastErr).slice(0, 500)}`);
}

// ── OpenAI 兼容（DeepSeek / Kimi / Qwen / Ollama / 各类网关）──
class OpenAICompatProvider implements Provider {
  name = "openai";
  private cfg: Config;
  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  async chat(o: ChatOptions): Promise<ChatResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: o.kind === "express" ? this.cfg.expressModel : this.cfg.appraiseModel,
      messages: [
        { role: "system", content: o.system },
        { role: "user", content: o.user },
      ],
      temperature: o.temperature ?? (o.kind === "express" ? 0.8 : 0.2),
      max_tokens: o.maxTokens ?? (o.kind === "express" ? 600 : 1500),
    };
    if (o.json) body.response_format = { type: "json_object" };

    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
    });
    if (!res.ok) throw new Error(`${this.name} ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
      model?: string;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    return {
      text,
      model: data.model ?? String(body.model),
      provider: this.name,
      tokensIn: data.usage?.prompt_tokens ?? estimateTokens(o.system + o.user),
      tokensOut: data.usage?.completion_tokens ?? estimateTokens(text),
      latencyMs: Date.now() - started,
    };
  }
}

// ── Anthropic（Claude）──────────────────────────────────────
class AnthropicProvider implements Provider {
  name = "anthropic";
  private cfg: Config;
  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  async chat(o: ChatOptions): Promise<ChatResult> {
    const started = Date.now();
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: o.kind === "express" ? this.cfg.expressModel : this.cfg.appraiseModel,
        max_tokens: o.maxTokens ?? 1500,
        temperature: o.temperature ?? (o.kind === "express" ? 0.8 : 0.2),
        system: o.system,
        messages: [{ role: "user", content: o.user }],
      }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
    });
    if (!res.ok) throw new Error(`${this.name} ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const data = (await res.json()) as {
      content: { type: string; text?: string }[];
      usage?: { input_tokens: number; output_tokens: number };
      model?: string;
    };
    const text = data.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    return {
      text,
      model: data.model ?? this.cfg.expressModel,
      provider: this.name,
      tokensIn: data.usage?.input_tokens ?? estimateTokens(o.system + o.user),
      tokensOut: data.usage?.output_tokens ?? estimateTokens(text),
      latencyMs: Date.now() - started,
    };
  }
}

// ── Mock：管道验证用的离线桩，产出合法但内容朴素的输出 ──────
class MockProvider implements Provider {
  name = "mock";
  private cfg: Config;
  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  async chat(o: ChatOptions): Promise<ChatResult> {
    const started = Date.now();
    await new Promise((r) => setTimeout(r, 0));
    const text = o.kind === "express" ? this.mockExpress(o) : this.mockAppraise(o);
    return {
      text,
      model: "mock",
      provider: this.name,
      tokensIn: estimateTokens(o.system + o.user),
      tokensOut: estimateTokens(text),
      latencyMs: Math.max(1, Date.now() - started),
    };
  }

  private mockAppraise(o: ChatOptions): string {
    const h = (o.hint ?? {}) as { userText?: string; assistantText?: string };
    const userText = (h.userText ?? "").trim();
    // 桩也要守住 schema：title >= 4、detail >= 6。
    // 以前这里不滤长度，"你好"会产出一张 2 字的卡，然后 chatJson 报
    // "输出不合 schema"并重试一次 —— 整条链路是对的，但日志里全是噪音。
    const clauses = userText
      .split(/[。！？!?；;\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 4)
      .slice(0, 2);
    const cards =
      clauses.length > 0
        ? clauses.map((c) => ({
            title: c.slice(0, 24),
            detail: `他跟我说：${c.slice(0, 60)}。`,
            kind: "event",
            status: "active",
            event_hint: "刚才",
            keywords: [],
            entities: [],
          }))
        : [];

    return JSON.stringify({
      attention: userText.slice(0, 40),
      meant_to_me: "【mock】这条是离线桩写下的，只用来验证管道。",
      felt: { valence: 0.1, arousal: 0.35, labels: ["平静"] },
      i_did: (h.assistantText ?? "").slice(0, 40),
      i_wanted: "想听懂他在说什么",
      outcome: "",
      not_known: "",
      satisfies: ["connection"],
      scores: { self_relevance: 0.55, novelty: 0.45, user_signal: 0.6, goal_relevance: 0.3 },
      cards,
      open_loops: [],
    });
  }

  private mockExpress(o: ChatOptions): string {
    const h = (o.hint ?? {}) as { userText?: string; cardCount?: number };
    const speech = (h.cardCount ?? 0) > 0 ? "嗯……我想了一下刚才的话。" : "嗯。";
    return JSON.stringify({
      speech,
      says_nothing: false,
      pause_before_ms: 200,
      emotion: { valence: 0.1, arousal: 0.35, label: "平静", intensity: 0.5 },
      gaze: "user",
      breaks_motivation: false,
      note_to_self: "【mock】",
      want_detail: [],
    });
  }
}

export function createProvider(cfg: Config): Provider {
  const p: ProviderName = cfg.provider;
  if (p === "openai") return new OpenAICompatProvider(cfg);
  if (p === "anthropic") return new AnthropicProvider(cfg);
  return new MockProvider(cfg);
}

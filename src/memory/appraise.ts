/**
 * 主观编码 —— 系统的"唯一写入者"。
 *
 * 它**不是总结对话**，而是让模型以助手的第一人称写下"我刚刚经历了什么"，
 * 并且把每件事压成**卡片**：什么时间、什么性质、现在还成不成立、以后用什么词搜。
 *
 * 新增的两项硬要求（v2）：
 *   · event_at_iso：模型要尽力给出绝对时间。给了，时间通道才有效；
 *   · status：要分清"事实 / 玩笑 / 已失效 / 当时就没确定"。
 *     这一项直接决定助手会不会把三周前的玩笑当成现在的事实。
 *
 * 调用约定：Brain 先取「本轮之前的」trace 快照传进来当 transcript，
 * 本轮的 user/assistant 由本函数拼在末尾。所以进这里之前 trace 里不该有本轮。
 *
 * 想改记忆质量，改 src/prompts/appraise.system.md，不要改这个文件。
 */
import type { Env } from "../env.ts";
import type { Appraisal, MotivationCard } from "../shared/types.ts";
import { AppraisalSchema } from "../shared/types.ts";
import { chatJson } from "../llm/provider.ts";
import { loadPrompt, render } from "../express/templates.ts";
import { renderDialogue, DIALOGUE_FORMAT_NOTE } from "../shared/dialogue.ts";
import { fuzzyTime } from "../shared/time.ts";
import type { CardRow, PersonRow } from "../store/repos.ts";
import { aliasesOf, allPersons, logPrompt, safeJsonArray } from "../store/repos.ts";

export interface Utterance {
  role: "user" | "me";
  content: string;
  ts: number;
}

export interface AppraiseInput {
  userText: string;
  assistantText: string;
  transcript: Utterance[];
  card: MotivationCard | null;
  person: PersonRow;
  /** 已经记过的卡片（本段最近 + 本轮召回），用来阻止重复记同一件事 */
  knownCards: CardRow[];
  now: number;
}

export interface AppraiseResult {
  appraisal: Appraisal;
  raw: { tokensIn: number; tokensOut: number; latencyMs: number };
}

function renderTranscript(turns: Utterance[]): string {
  // 格式见 shared/dialogue.ts：我说的带「我：」，他说的裸着。
  return renderDialogue(turns.map((t) => ({ role: t.role, content: t.content })));
}

function renderPerson(p: PersonRow, now: number): string {
  const seen = p.last_seen_at ? fuzzyTime(p.last_seen_at, now) : "刚认识";
  const bits = [
    `${p.name}（${p.is_primary ? "主要的人" : "认识的人"}）`,
    `亲近感 ${p.closeness.toFixed(2)} / 信任 ${p.trust.toFixed(2)}`,
    `上次见面：${seen}`,
  ];
  if (p.impression) bits.push(`我对他的印象：${p.impression}`);
  return bits.join("\n");
}

function renderKnownCards(cards: CardRow[], now: number): string {
  if (cards.length === 0) return "（还没有记过关于他的事）";
  // #id 必须在场：v3 起编码器要能在 links 里**指着已有卡片**说因果，
  // 而 v2 只给标题不给编号 —— 那条通路从一开始就不可能被用上。
  return cards
    .map((c) => {
      const kw = safeJsonArray(c.keywords).slice(0, 3).join("/");
      const status = c.status === "active" ? "" : `〔${c.status}〕`;
      const kind = c.kind === "event" ? "" : `[${c.kind}]`;
      return `- #${c.id} ${fuzzyTime(c.event_at, now)} · ${kind}${c.title}${status}${kw ? `（${kw}）` : ""}`;
    })
    .join("\n");
}

/**
 * 我认识的人（v4）。给编码器看的两件事：
 *   ① 我已经知道谁是谁了 —— 它才能把 this 轮提到的人对上号
 *   ② 谁我还不知道是谁 —— 它才知道该不该报 speaker 线索
 */
function renderPeople(env: Env): string {
  const persons = allPersons(env.db);
  if (persons.length === 0) return "（还没有记过任何人）";
  const label: Record<string, string> = { unknown: "不知道是谁", provisional: "只知道个叫法", known: "知道他叫什么" };
  return persons
    .map((p) => {
      const names = aliasesOf(env.db, p.id).map((a) => a.alias);
      const call = p.display_name ?? p.name;
      return `- #${p.id} 我叫他「${call}」${names.length > 0 ? `（别名：${names.join("、")}）` : ""} · ${label[p.dossier_status] ?? p.dossier_status}`;
    })
    .join("\n");
}

export async function appraise(env: Env, input: AppraiseInput): Promise<AppraiseResult> {
  const system = loadPrompt("appraise.system");

  // 主动发言时他没有说话。以前这里会拼一个空白的「他：」行进去，
  // 编码器只能猜"他刚才什么也没说算不算一件事"，很容易写出一张空卡。
  // 现在明确告诉它：这一轮是我自己在说。
  const turns: Utterance[] = [...input.transcript];
  if (input.userText.trim()) turns.push({ role: "user", content: input.userText, ts: input.now });
  if (input.assistantText) turns.push({ role: "me", content: input.assistantText, ts: input.now });

  const d = new Date(input.now);
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  const nowText = `${d.toLocaleString("zh-CN", { hour12: false })}（周${weekday}）`;

  const user = render(loadPrompt("appraise.user"), {
    NOW: nowText,
    TODAY_ISO: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    DIALOGUE_NOTE: DIALOGUE_FORMAT_NOTE,
    TRANSCRIPT: renderTranscript(turns.slice(-10)),
    MOTIVATION: input.card
      ? `意图=${input.card.intent}，驱动=${input.card.drive}，我本来想：${input.card.desired_outcome}`
      : "（没有主动动机，只是回应他）",
    PERSON: renderPerson(input.person, input.now),
    KNOWN_CARDS: renderKnownCards(input.knownCards, input.now),
    KNOWN_PEOPLE: renderPeople(env),
    // 没配名字（白模就是）时给一句读得通的话，而不是把「（没配）」塞进句子里
    SELF_NAMES:
      env.persona.selfNames.length > 0
        ? `我的名字是：${env.persona.selfNames.join("、")}。这些是我，不是别人。`
        : "（我还没给自己起名字。）",
  });

  const { value, raw } = await chatJson(
    env.llm,
    {
      kind: "appraise",
      system,
      user,
      temperature: 0.2,
      json: { name: "appraisal", schema: { type: "object" } },
      hint: { userText: input.userText, assistantText: input.assistantText },
    },
    AppraisalSchema,
  );

  logPrompt(env.db, {
    ts: input.now,
    kind: "appraise",
    model: env.cfg.appraiseModel,
    promptVersion: env.persona.hash,
    prompt: `${system}\n\n----\n\n${user}`,
    response: raw.text,
    tokensIn: raw.tokensIn,
    tokensOut: raw.tokensOut,
    costUsd: 0,
    latencyMs: raw.latencyMs,
    error: null,
  });

  return { appraisal: value, raw };
}

/**
 * 提示词组装。结构变化（v3）：记忆分三个层次。
 *
 *   memories  卡片骨架（时间 · 状态 · 一句话 · 关键词）← 先锁定"是哪件事"
 *      ├ attention   我注意到的那一部分      ← v3 新增（以前生成了就丢）
 *      ├ not_known   我当时没懂、也没问出口   ← v3 新增（一直是死字段）
 *      └ thread      这条线的来龙去脉        ← v3 新增（巩固花钱写的，以前没人读）
 *   details   原始记录（只在模型要了细节时才有）        ← 再翻"当时具体说了什么"
 *
 * 为什么骨架里**不放 detail 全文**：
 *   一旦把每张卡片的完整正文都塞进去，模型就没有理由去翻原话，
 *   于是"两段式回忆"退化成"读一遍摘要然后凭印象说"。
 *   骨架只给足够定位的信息，细节要它主动要。
 *
 * 分区顺序仍然是缓存设计：persona 在 system（跨轮不变），
 * user 从慢到快：self → person → motivation → memories → details → recent → loops → utterance。
 */
import { loadPrompt, render } from "./templates.ts";
import { DIALOGUE_FORMAT_NOTE, renderDialogue } from "../shared/dialogue.ts";
import type { MotivationCard, PersonDossier, RetrievedCard, TraceSlice } from "../shared/types.ts";
import type { OpenLoopRow, PersonRow, SelfSheetRow, TraceRow } from "../store/repos.ts";

export interface AssembleInput {
  now: number;
  person: PersonRow;
  /** v4：人物档案（称呼/别名/我知道的关于他的事/还不知道的） */
  dossier?: PersonDossier | null;
  self: SelfSheetRow | undefined;
  card: MotivationCard;
  cards: RetrievedCard[];
  recent: TraceRow[];
  loops: OpenLoopRow[];
  /** 本轮用户原句。为空表示这轮是主动发言（他没说话） */
  currentUtterance: string;
  /** 第二段才有的原始记录 */
  details?: TraceSlice[];
}

export interface PromptSection {
  name: string;
  stable: boolean;
  text: string;
}

export interface AssembledPrompt {
  system: string;
  user: string;
  sections: PromptSection[];
}

const STATUS_LABEL: Record<string, string> = {
  active: "仍成立",
  expired: "已失效",
  retracted: "已改口",
  uncertain: "当时没定",
};

const KIND_LABEL: Record<string, string> = {
  event: "事件",
  fact: "事实",
  preference: "喜好",
  relation: "关系",
  self: "我自己",
  plan: "打算",
  joke: "玩笑",
};

/** 卡片正文摘录的长度上限。超过就截断——它是"我的转述"，不是原话，没必要给全 */
const DETAIL_CLIP = 60;

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

/**
 * 卡片骨架。每条两行起：
 *   第一行 定位用：时间 · 性质 · 状态 · 标题 · 关键词
 *   第二行 摘录用：detail 的前 60 字（我的转述，含当时的感受）
 * 之后按需追加三类"视角"信息（v3）：
 *   ↳ 摘录   /  ◎ 我注意到的 /  ○ 我当时没懂 /  ≈ 这条线的来龙去脉
 *
 * 为什么给摘录而不是全文：
 *   detail 是"我事后转述的话"，不是对方原话；给全文会诱导模型把它当成引语复述。
 *   而完全不给（v2 初版的做法）又太薄 —— "我听着有点心疼"这类感受传不上去，
 *   卡片退化成一句标题。摘录是这两者之间的折中：够让语气有依据，不够到能照抄。
 *   真要逐字原话，仍然走第二段（want_detail → 翻 trace）。
 *
 * 为什么"来龙去脉"每条线只渲染一次：
 *   同一条线会有好几张卡一起被召回（线程展开就是干这个的）。每张都写一遍
 *   summary 会把 token 预算吃光，而且模型会以为那是好几件不同的事。
 */
export function renderCards(cards: RetrievedCard[]): string {
  if (cards.length === 0) return "（没想起什么）";
  const renderedThreads = new Set<number>();

  return cards
    .map((c) => {
      const tag = `[#${c.id}｜${KIND_LABEL[c.kind] ?? c.kind}｜${STATUS_LABEL[c.status] ?? c.status}]`;
      const kw = c.keywords.slice(0, 3).join("/");
      const thread = c.fromThread ? "（同一件事的前后变化）" : "";
      const unsure = c.confidence < 0.6 ? "〔我记得不太准〕" : "";
      const head = `· ${c.time_label} ${tag} ${c.title}${thread}${unsure}${kw ? `　⟨${kw}⟩` : ""}`;
      const lines: string[] = [head];

      const body = c.detail.replace(/\s+/g, " ").trim();
      if (body) lines.push(`   ↳ ${clip(body, DETAIL_CLIP)}`);
      if (c.attention) lines.push(`   ◎ 我当时注意到的是：${clip(c.attention, 50)}`);
      if (c.not_known) lines.push(`   ○ 我当时没懂、也没问：${clip(c.not_known, 50)}`);

      // 来龙去脉：每条线只说一次，挂在它的第一张卡上
      if (c.thread_id !== null && c.thread_summary && !renderedThreads.has(c.thread_id)) {
        renderedThreads.add(c.thread_id);
        lines.push(`   ≈ 这条线后来的变化：${clip(c.thread_summary, 90)}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

function renderDetails(details: TraceSlice[], cards: RetrievedCard[], now: number): string {
  if (details.length === 0) return "（还没翻）";
  return details
    .map((d) => {
      const meta = cards.find((c) => c.id === d.cardId);
      const head = `【卡片 #${d.cardId} · ${meta?.time_label ?? ""} · ${meta?.title ?? ""}】`;
      const body = renderDialogue(d.lines.map((l) => ({ role: l.role, content: l.content })));
      return `${head}\n${body}`;
    })
    .join("\n\n");
}

function closenessWord(v: number): string {
  if (v < 0.25) return "还很生";
  if (v < 0.45) return "有点熟了";
  if (v < 0.65) return "挺熟的";
  if (v < 0.85) return "亲近";
  return "很亲近";
}

function renderPerson(p: PersonRow, now: number, dossier?: PersonDossier | null): string {
  const lines: string[] = [];

  // 称呼：v4 起"我叫他什么"和"他叫什么"是两件事
  const call = dossier?.displayName ?? null;
  if (dossier && dossier.status !== "known") {
    // 不知道是谁的时候，第一行就是这一句 —— 它是她开口问的理由
    lines.push(call ? `我还不太确定对面是谁。我暂时叫他「${call}」。` : "我还不知道我在跟谁说话。");
  } else if (call) {
    lines.push(`他是「${call}」${dossier?.aliases.length ? `（他还有别的叫法：${dossier.aliases.join("、")}）` : ""}`);
  } else {
    lines.push(p.name);
  }

  lines.push(`亲近感「${closenessWord(p.closeness)}」，信任 ${p.trust.toFixed(2)}`);
  if (p.last_seen_at) lines.push(`上次说话：${new Date(p.last_seen_at).toLocaleDateString("zh-CN")}`);

  const traits = dossier?.traits ?? [];
  if (traits.length > 0) {
    // 这些就是卡片标题，不加二次概括 —— 她是照卡片说话的，
    // 摘要和卡片不一致时，模型会照着摘要编。
    lines.push(`我知道他的：${traits.slice(0, 5).map((t) => t.trait).join("；")}`);
  } else if (p.impression) {
    lines.push(`我对他的印象：${p.impression}`);
  }

  const unknown = (dossier?.openQuestions ?? []).filter((q) => q !== "我在跟谁说话");
  if (unknown.length > 0) lines.push(`我还不知道的：${unknown.slice(0, 3).join("；")}`);

  return lines.join("\n");
}

function renderLoops(loops: OpenLoopRow[], now: number): string {
  if (loops.length === 0) return "（没有悬着的事）";
  return loops
    .map((l) => {
      const age = Math.floor((now - l.created_at) / 86_400_000);
      const when = age >= 1 ? `记了 ${age} 天` : "刚记下";
      // escalation > 0 说明之前试过并且没成 —— 这个信息必须进提示词，
      // 否则"加筹码"这件事在措辞上根本体现不出来。
      const tries = l.escalation > 0 ? `，已经试过 ${l.escalation} 次没成` : "";
      const warn = l.mentioned_count >= 3 && l.escalation <= 1 ? `，已经提过 ${l.mentioned_count} 次` : "";
      return `- ${l.text}（${when}${tries}${warn}）`;
    })
    .join("\n");
}

/**
 * 本轮用户原句。
 * 放在提示词最末尾（紧挨"现在说话"）是刻意的：模型对最后出现的内容权重最高，
 * 而"回应最新这一句"恰恰是最容易被上一轮内容带跑的指令。
 */
function renderUtterance(text: string): string {
  const t = text.trim();
  if (!t) return "（他这次没说话。是你自己想开口。）";
  return t;
}

function renderRecent(traces: TraceRow[]): string {
  if (traces.length === 0) return "（这是刚开始）";
  // 格式见 shared/dialogue.ts：我说的带「我：」，他说的裸着。
  return renderDialogue(traces.map((t) => ({ role: t.role, content: t.content })));
}

export function assemble(env: { persona: { system: string } }, input: AssembleInput): AssembledPrompt {
  const sections: PromptSection[] = [
    { name: "self", stable: false, text: input.self?.summary ?? "（我还没想清楚自己是谁）" },
    { name: "person", stable: false, text: renderPerson(input.person, input.now, input.dossier) },
    { name: "motivation", stable: false, text: JSON.stringify(input.card, null, 2) },
    { name: "memories", stable: false, text: renderCards(input.cards) },
    { name: "details", stable: false, text: renderDetails(input.details ?? [], input.cards, input.now) },
    { name: "recent", stable: false, text: renderRecent(input.recent.slice(-6)) },
    { name: "loops", stable: false, text: renderLoops(input.loops, input.now) },
    { name: "utterance", stable: false, text: renderUtterance(input.currentUtterance) },
  ];

  const byName = new Map(sections.map((s) => [s.name, s.text]));
  const user = render(loadPrompt("express.user"), {
    SELF: byName.get("self"),
    PERSON: byName.get("person"),
    CARD: byName.get("motivation"),
    MEMORIES: byName.get("memories"),
    DETAILS: byName.get("details"),
    DIALOGUE_NOTE: DIALOGUE_FORMAT_NOTE,
    RECENT: byName.get("recent"),
    LOOPS: byName.get("loops"),
    UTTERANCE: byName.get("utterance"),
  });

  return { system: env.persona.system, user, sections };
}

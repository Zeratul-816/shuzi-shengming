/**
 * 人物档案 —— 身份解析与归档。
 *
 * ── 这条线要解决的问题 ───────────────────────────────────
 *   她看不见对面是谁。v3 之前系统的处理方式是假装知道：`primaryPerson()`
 *   直接返回一个 name 硬编码成「你」的槽位，35 张卡片的 person_id 全是 1。
 *   名字他其实报过（「开发者」），只是没有地方挂。
 *
 *   v4 的处理方式是承认不知道：每次醒来都是 `dossier_status = 'unknown'`，
 *   于是第一轮她得问。他把名字说出来之后，那个词才变成 alias，
 *   信息才开始往一张具体的档案里归。
 *
 * ── 三条通道，各自受控 ───────────────────────────────────
 *   1. **同步解析**（reply 之前跑，纯规则）：`我是X` / `叫我X` / 命中已有别名 /
 *      「是我」这类指认。必须在调表达层之前完成 —— 否则他刚报完名，
 *      她这一轮还在问"你是谁"。
 *   2. **编码器回报**（异步，`Appraisal.speaker`）：他的一句较长的话里
 *      报了名，规则没抓住的，由编码层补。它晚一轮生效，这是可以接受的。
 *   3. **实体/他人**（`Appraisal.people` + `CardDraft.about`）：提到的**其他人**
 *      才会新建档案。**绝不**把 entities 一股脑当人物 —— 里面混着「公司」「报错」，
 *      还有她自己的名字（真机上 12 次）。
 *
 * ── 只守机制，不守内容 ──────────────────────────────────
 *   这里**没有**"认得对不对"的检查。抽错了名字、把她自己的名字当成别人、
 *   以为"我是说"里的"说"是他的名字——这些都允许发生。
 *   一个从不认错的识别人不是人。要保证的只有机制层面的事：
 *   · 名字能被绑定（bindIdentity）
 *   · 绑错了能改过来（后来再报一次名会覆盖 display_name，旧别名留着）
 *   · 不会无限建档案（同一个人靠别名复用）
 */
import type { Env } from "../env.ts";
import type {
  CardDraft,
  DossierStatus,
  PersonDossier,
  PersonMention,
  SpeakerDraft,
} from "../shared/types.ts";
import type { CardRow, PersonRow } from "../store/repos.ts";
import { all, get } from "../store/db.ts";
import {
  addAlias,
  aliasesOf,
  countCardsOfPerson,
  createPerson,
  getPerson,
  primaryPerson,
  topCardsOfPerson,
  updateDossier,
} from "../store/repos.ts";
import { bigramDice } from "../store/bigram.ts";

/** 最多问几次"你是谁"。问三次他都不说，就不再问了 —— 她不会追着人问这个。 */
export const MAX_ASKS = 3;

/**
 * 从一句话里抽出他自报的名字。
 *
 * 只认四种句式：我是X / 我叫X / 叫我X / 我姓X。
 * 后面的边界（标点/空白/句末）是**切词**用的，不是语义检查：
 * 没有它，"我是开发者之前来过"会被整段吃成名字。
 *
 * ★ 这里**故意不做语义过滤**。
 *   所以「我是说，你可能误会了」会被抽成"说"。
 *   这是错的 —— 但错的成本只是她一段时间里管他叫"说"，
 *   而他下次正经说一句"我叫小林"就能改过来（bindIdentity 会覆盖称呼、
 *   旧别名留着）。
 *   不做的理由：子功能只需要**机制跑顺**，内容上的对错由她和他一起消化。
 *   一个从不认错名字的存在不是人，是查表。
 */
export function extractSelfIntro(text: string): string | null {
  const patterns = [
    /我是([\u4e00-\u9fa5A-Za-z0-9]{1,8})(?=[，。！？、,.!?…\s]|$)/,
    /我叫([\u4e00-\u9fa5A-Za-z0-9]{1,8})(?=[，。！？、,.!?…\s]|$)/,
    /叫我([\u4e00-\u9fa5A-Za-z0-9]{1,8})(?=[，。！？、,.!?…\s]|$)/,
    /我姓([\u4e00-\u9fa5]{1,2})(?=[，。！？、,.!?…\s]|$)/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const word = m[1];
    if (word.length < 1) continue;
    return word;
  }
  return null;
}

/**
 * 他这句话里有没有"是我"这类指认（没报名，但明确是同一个熟人）。
 * 只在**恰好一个人**的库里生效 —— 有两个人时这句话是歧义的，不该猜。
 */
export function looksLikeSamePerson(text: string): boolean {
  return /^(是我|还是我|我啊|是我啊|我来了|还在吗|是我呀)/.test(text.trim());
}

/**
 * 他这句话里有没有叫我名字。
 *
 * 这是 persona/self.json 现在**唯一**的用途：知道他在叫我。
 * 它不再用来"挡住别人拿我的名字当名字"——那种事允许发生。
 */
export function extractCalledAs(env: Env, text: string): string | null {
  for (const n of env.persona.selfNames) {
    if (text.includes(n)) return n;
  }
  return null;
}

/** 在已有别名里找命中（包含式，长别名优先） */
export function matchAlias(
  env: Env,
  text: string,
  aliases: { person_id: number; alias: string; confidence: number }[],
): { personId: number; alias: string; confidence: number } | null {
  let best: { personId: number; alias: string; confidence: number } | null = null;
  for (const a of aliases) {
    if (a.alias.length < 2) continue;
    if (!text.includes(a.alias)) continue;
    if (!best || a.alias.length > best.alias.length) {
      best = { personId: a.person_id, alias: a.alias, confidence: a.confidence };
    }
  }
  return best;
}

// ── 绑定身份 ───────────────────────────────────────────────
/**
 * 把一个名字挂到他身上。这是"档案开始被填"的那一刻。
 *
 * `introduced=true` 才是他自己报的名 → 状态升到 known，`asked_count` 归零
 * （上次问过的账一笔勾销）。否则只升到 provisional。
 */
export function bindIdentity(
  env: Env,
  personId: number,
  label: string,
  opts: { introduced: boolean; now: number; sourceCardId?: number | null },
): void {
  const alias = label.trim();
  if (!alias) return;
  addAlias(env.db, personId, alias, {
    kind: opts.introduced ? "name" : "role",
    confidence: opts.introduced ? 1 : 0.6,
    sourceCardId: opts.sourceCardId ?? null,
    now: opts.now,
  });
  const cur = getPerson(env.db, personId);
  const status: DossierStatus = opts.introduced ? "known" : cur?.dossier_status === "known" ? "known" : "provisional";
  updateDossier(
    env.db,
    personId,
    {
      display_name: alias,
      dossier_status: status,
      ...(opts.introduced ? { self_intro_at: opts.now, asked_count: 0 } : {}),
    },
    opts.now,
  );
}

/**
 * 同步解析：他这一句话说明了他是谁吗。
 *
 * 顺序有讲究：
 *   1. 自报名字（最强证据）
 *   2. 命中已有别名
 *   3. "是我" —— 只有**恰好一个人**的时候才敢这么认
 * 返回 null = 还不知道。
 */
export function resolveIdentityFromText(
  env: Env,
  text: string,
  now: number,
): { personId: number; label: string | null; introduced: boolean } | null {
  const intro = extractSelfIntro(text);
  if (intro) {
    const target = primaryPerson(env.db, now);
    bindIdentity(env, target.id, intro, { introduced: true, now });
    return { personId: target.id, label: intro, introduced: true };
  }

  const aliases = all<{ person_id: number; alias: string; confidence: number }>(
    env.db,
    "SELECT person_id, alias, confidence FROM person_alias",
  );
  const hit = matchAlias(env, text, aliases);
  if (hit) {
    updateDossier(env.db, hit.personId, { dossier_status: "known", last_asked_at: null }, now);
    return { personId: hit.personId, label: hit.alias, introduced: false };
  }

  if (looksLikeSamePerson(text)) {
    const persons = all<PersonRow>(env.db, "SELECT * FROM person");
    if (persons.length === 1) {
      const p = persons[0];
      updateDossier(
        env.db,
        p.id,
        { dossier_status: p.dossier_status === "unknown" ? "provisional" : p.dossier_status },
        now,
      );
      return { personId: p.id, label: null, introduced: false };
    }
  }
  return null;
}

/** 编码器回报的 speaker：晚一轮生效，作为规则解析的补漏 */
export function applySpeakerDraft(env: Env, speaker: SpeakerDraft, now: number, cardId: number | null): void {
  const label = speaker.label.trim();
  if (!label) return;
  const target = primaryPerson(env.db, now);
  bindIdentity(env, target.id, label, { introduced: speaker.introduced, now, sourceCardId: cardId });
}

/**
 * 这一轮提到的**其他**人：新建或命中已有档案。
 * 返回 name → personId，供卡片的 `about` 用。
 */
export function applyPeopleMentions(env: Env, people: PersonMention[], now: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of people) {
    const name = m.name.trim();
    if (!name) continue;
    const aliases = all<{ person_id: number; alias: string; confidence: number }>(
      env.db,
      "SELECT person_id, alias, confidence FROM person_alias",
    );
    const exact = aliases.find((a) => a.alias === name);
    if (exact) {
      out.set(name, exact.person_id);
      continue;
    }
    // 模糊命中：同一个人的两种写法（"小林"/"林工"不算，但"小林"/"小林哥"算）
    const fuzzy = aliases.find((a) => bigramDice(a.alias, name) >= 0.6);
    if (fuzzy) {
      out.set(name, fuzzy.person_id);
      continue;
    }
    const id = createPerson(env.db, { name, status: "provisional", now });
    if (m.relation) {
      addAlias(env.db, id, m.relation, { kind: "role", confidence: 0.7, now });
    }
    addAlias(env.db, id, name, { kind: "name", confidence: 0.8, now });
    out.set(name, id);
  }
  return out;
}

/**
 * 卡片归属：这张卡是关于谁的。
 *   about 为空 → 他（正在跟我说话的人）
 *   about 命中别名 → 那个人
 *   about 没命中 → 当成新出现的人？**不**。留给他，别凭空造档案。
 */
export function resolveCardSubject(
  env: Env,
  draft: CardDraft,
  defaultPersonId: number,
  peopleMap: Map<string, number>,
): number {
  const about = draft.about?.trim();
  if (!about) return defaultPersonId;
  const mapped = peopleMap.get(about);
  if (mapped) return mapped;
  const aliases = allAliasesRaw(env);
  const exact = aliases.find((a) => a.alias === about);
  if (exact) return exact.person_id;
  const fuzzy = aliases.find((a) => bigramDice(a.alias, about) >= 0.6);
  if (fuzzy) return fuzzy.person_id;
  return defaultPersonId;
}

function allAliasesRaw(env: Env): { person_id: number; alias: string }[] {
  return all<{ person_id: number; alias: string }>(env.db, "SELECT person_id, alias FROM person_alias");
}

// ── 档案的读与写 ───────────────────────────────────────────
/**
 * 重新聚合一张档案。便宜（几条 SQL），可以在每轮 postProcess 之后跑。
 * traits 直接来自卡片标题 —— 不做二次生成，因为"我知道的关于他的事"
 * 本来就该和卡片一字不差：她是照卡片说话的。
 */
export function refreshDossier(env: Env, personId: number, now: number): void {
  const cards = topCardsOfPerson(env.db, personId, 6);
  const traits = cards.map((c: CardRow) => ({
    trait: c.title,
    confidence: Number(c.confidence.toFixed(2)),
    card_id: c.id,
  }));
  const impression = cards.slice(0, 3).map((c) => c.title).join("；").slice(0, 160) || null;
  updateDossier(
    env.db,
    personId,
    { traits: JSON.stringify(traits), impression },
    now,
  );
}

export function dossierOf(env: Env, personId: number, now: number): PersonDossier | null {
  const p = getPerson(env.db, personId);
  if (!p) return null;
  const aliases = aliasesOf(env.db, personId).map((a) => a.alias);
  const traits = safeJson<{ trait: string; confidence: number; card_id: number | null }[]>(p.traits, []).map((t) => ({
    trait: t.trait,
    confidence: t.confidence,
    cardId: t.card_id ?? null,
  }));
  const openQuestions = safeJson<string[]>(p.open_questions, []);
  // 还不知道他是谁的时候，把"不知道什么"显式列出来 ——
  // 这一段就是她开口问的理由，不必再让模型自己猜该问什么。
  if (p.dossier_status !== "known") {
    openQuestions.unshift("他叫什么");
    if (p.dossier_status === "unknown") openQuestions.unshift("我在跟谁说话");
  }
  return {
    id: p.id,
    name: p.name,
    displayName: p.display_name,
    status: p.dossier_status,
    aliases,
    closeness: p.closeness,
    trust: p.trust,
    warmth: p.warmth,
    traits,
    openQuestions: [...new Set(openQuestions)],
    cardCount: countCardsOfPerson(env.db, personId),
    askedCount: p.asked_count,
    lastSeenAt: p.last_seen_at,
  };
}

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 该不该问"你是谁"。同一次苏醒只问一次；累计三次没答就不再问。 */
export function shouldAskIdentity(env: Env, personId: number, opts: { askedThisAwakening: boolean }): boolean {
  const p = getPerson(env.db, personId);
  if (!p) return false;
  if (p.dossier_status === "known") return false;
  if (p.asked_count >= MAX_ASKS) return false;
  if (opts.askedThisAwakening) return false;
  return true;
}

/** 记一次"我问了" */
export function noteAsked(env: Env, personId: number, now: number): void {
  const p = getPerson(env.db, personId);
  if (!p) return;
  updateDossier(env.db, personId, { asked_count: p.asked_count + 1, last_asked_at: now }, now);
}

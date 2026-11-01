/**
 * 终端 REPL。白模的"壳"就是它——故意做得很薄：所有智能都在 brain/ 里，
 * 换成 Electron 窗口时这个文件整个扔掉，别的不用动。
 *
 * 循环的四个职责：
 *   1. 读行        用 for-await 读 readline（管道输入下 rl.question 只返回第一行）
 *   2. 分派命令    调试视图；/sleep /purge /reseed 会写库
 *   3. 每轮先 settle  上一轮的后台写卡片任务落地后再开始下一轮，否则会"失忆一轮"
 *   4. 定时 tick   每 DH_TICK_MS 调一次 brain.proactive()，null 就什么都不做
 */
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { maskKey, ROOT } from "../config.ts";
import { createEnv } from "../env.ts";
import { Brain } from "../brain.ts";
import { consolidate, purgeMockCards } from "../memory/consolidate.ts";
import { expandCard } from "../memory/retrieve.ts";
import { forceStatus, previewExpirations, refreshStatuses } from "../memory/status.ts";
import {
  addAlias,
  aliasesOf,
  allPersons,
  auditStats,
  awakeningCount,
  costStats,
  getCards,
  getPerson,
  linksOfCard,
  listOpenLoops,
  liveCards,
  primaryPerson,
  recallStats,
  recentAwakenings,
  recentStatusLog,
  recentTickLog,
  violationHistogram,
} from "../store/repos.ts";
import { dossierOf, MAX_ASKS } from "../memory/person.ts";
import { needsTable } from "../motivation/tick.ts";
import { clearPromptCache } from "../express/templates.ts";
import { PersonaError, personaDrift } from "../express/persona.ts";
import { fuzzyTime } from "../shared/time.ts";
import type { TurnResult } from "../brain.ts";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

const DEBUG = process.env.DH_DEBUG === "1";

const STATUS_MARK: Record<string, string> = {
  active: "仍成立",
  expired: "已失效",
  retracted: "已改口",
  uncertain: "当时没定",
};

/**
 * 横幅。
 *
 * ★ 边框宽度按**显示宽度**算，不手数空格 —— 原来的框是手画的，
 *   改一次标题就得重数一次，而"忘了一起改"的代价是启动第一眼就在骗人
 *   （它到 v4 还在说"白模 v2"）。这类东西不参与执行，不会报错，
 *   只能靠不要手算。
 */
function displayWidth(s: string): number {
  let n = 0;
  for (const ch of s) {
    // 中日韩文字与全角标点占两格，其余一格
    n += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch)
      ? 2
      : 1;
  }
  return n;
}

function boxed(title: string, subtitle: string, width = 47): string[] {
  const pad = (s: string) => " ".repeat(Math.max(0, width - displayWidth(s)));
  return [
    `  ╭${"─".repeat(width + 2)}╮`,
    `  │ ${title}${pad(title)} │`,
    `  │ ${C.dim(subtitle)}${pad(subtitle)} │`,
    `  ╰${"─".repeat(width + 2)}╯`,
  ];
}

/**
 * 给人看的路径：能落在项目里就用**相对 数字生命 的路径**，落不进去才给绝对路径。
 *
 * 为什么：绝对路径在屏幕上又长又没用（换台机器就全不一样），
 * 而项目内的一切索引——README、docs、这个横幅——都该以根目录为准。
 * 只有 DH_DB_PATH 指到项目外面时例外：那时的相对路径会变成 ../../..，
 * 反而看不出东西在哪。
 */
function shownPath(p: string): string {
  const rel = path.relative(ROOT, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.replace(/\\/g, "/") : p;
}

function banner(env: ReturnType<typeof createEnv>, brain: Brain): string {
  const { cfg } = env;
  const mode =
    cfg.provider === "mock"
      ? C.yellow("mock（离线桩：只验证管道，写下的卡片带 mock 标记）")
      : C.green(`${cfg.provider} · 表达=${cfg.expressModel} · 编码=${cfg.appraiseModel}`);
  const st = brain.stats();

  const now = Date.now();
  const person = primaryPerson(env.db, now);
  const d = dossierOf(env, person.id, now);
  const who =
    d && d.status === "known"
      ? // 注意：这是**档案里**的名字，不是"这一次已经确认过了"。
        // 每次苏醒谈话对象都是待定的，她还是会先问一遍 —— 措辞别让它看起来相反。
        `${d.displayName ?? person.name}（上一次确认的）· 关于他 ${d.cardCount} 张卡`
      : d && d.displayName
        ? `暂时叫他「${d.displayName}」，还没确认 · 关于他 ${d.cardCount} 张卡`
        : C.yellow("档案还是空的 —— 第一轮她会先问");
  const awake = awakeningCount(env.db);

  // 标题跟着人设走：没配名字的人设（仓库里带的「白模」就是这样）就显示 白模，
  // 免得屏幕上写着某个角色的名字、开口却是另一个。
  const title = env.persona.selfNames[0] ?? "白模";
  const lines = [
    "",
    // 注意：传给 boxed 的必须是**没有颜色码**的纯文本 ——
    // displayWidth 会把 ANSI 转义序列的字符也算进去，padding 就少了。
    // 颜色在 boxed 之后整行加。
    ...boxed(`数字生命 · ${title}`, "卡片记忆 · 动机引擎 · 人物档案").map((l) => C.bold(l)),
    C.dim(`  模型      ${mode}`),
  ];

  if (cfg.provider !== "mock") {
    const from = cfg.keySource ? `来自 ${cfg.keySource}，${maskKey(cfg.apiKey)}` : "未找到 key";
    lines.push(C.dim(`  API key   ${from}`));
  }
  lines.push(
    C.dim(`  记忆库    ${shownPath(cfg.dbPath)}`),
    C.dim(`  已有卡片  ${st.cards} 张 · 第 ${st.episodeId} 段相处 · 第 ${awake} 次苏醒`),
    C.dim(`  人物      ${who}`),
    C.dim(`  人设      persona/ 编译版 ${env.persona.hash}`),
    C.dim(`  召回      关键词/时间/未了之事/种子/情绪同频/反刍 → 骨架 → 按需翻原话`),
    C.dim(`  输入 /help 看命令，/quit 退出`),
  );

  if (cfg.keyRisky) {
    lines.push(
      "",
      C.yellow(`  ⚠ key 文件放在版本库目录里（${cfg.keySource}），有被误提交的风险。`),
      C.yellow(`    建议移到主目录：~/.deepseek_api_key（程序会自动找到它）。`),
    );
  }
  lines.push("");
  return lines.join("\n");
}

function printTurn(r: TurnResult): void {
  const who = r.kind === "proactive" ? C.magenta("我（主动）") : C.cyan("我");
  if (r.saysNothing || !r.speech) {
    const why = r.silenceKind === "declining" ? "（没接这个话头）" : "（没说话）";
    console.log(`${who} ${C.dim(why)}`);
  } else {
    console.log(`${who} ▸ ${r.speech}`);
  }
  if (DEBUG) {
    const emo = r.out.emotion;
    const disp = r.displayEmotion;
    const ch = Object.entries(r.channels)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}:${n}`)
      .join(" ");
    console.log(
      C.dim(
        `   ↳ 意图=${r.card.intent} 驱动=${r.card.drive} 紧急=${r.card.urgency} ` +
          `情绪=${emo.label}(${emo.valence.toFixed(2)}→对外${disp.valence.toFixed(2)}) ` +
          `卡片=${r.recalled.length} [${ch}]${r.expanded ? " 已翻原话" : ""} ` +
          `${r.audit.sentences}句/${r.audit.chars}字 ${r.latencyMs}ms`,
      ),
    );
    if (r.expanded) {
      console.log(C.dim(`   ↳ 翻了：#${r.details.map((d) => d.cardId).join(", #")}`));
    }
    const flags = Object.entries(r.read)
      .filter(([k, v]) => v === true && k !== "empty")
      .map(([k]) => k);
    if (flags.length > 0) console.log(C.dim(`   ↳ 把他这句读成：${flags.join(" / ")}`));
    if (r.audit.violations.length > 0) {
      const v = r.audit.violations.map((x) => x.code).join(",");
      const retry = r.audit.retried ? (r.audit.fixed ? "（重说后改好）" : "（重说没改好）") : "";
      console.log(C.red(`   ↳ 违规：${v}${retry}`));
    }
    if (r.out.note_to_self) console.log(C.dim(`   ↳ 心得：${r.out.note_to_self}`));
  }
  console.log();
}

async function main(): Promise<void> {
  const env = createEnv();
  const brain = new Brain(env);
  console.log(banner(env, brain));

  const drift = personaDrift(env.db);
  if (drift.stale) {
    console.log(C.yellow(`  提示：persona/ 已改动（${drift.personaHash}），当前自我叙事是 v${drift.activeVersion}。`));
    console.log(C.yellow(`        执行 /reseed 把新的人设重新编译落库。\n`));
  }

  const rl = readline.createInterface({ input, output, terminal: process.stdin.isTTY === true });
  let running = true;

  const timer = setInterval(async () => {
    try {
      const r = await brain.proactive();
      if (r) {
        output.write("\r\x1b[K");
        printTurn(r);
        rl.prompt();
      }
    } catch (e) {
      console.error(C.red(`[主动发言失败] ${(e as Error).message}`));
    }
  }, env.cfg.tickMs);
  timer.unref?.();

  rl.on("SIGINT", () => {
    running = false;
    rl.close();
  });

  if (process.stdin.isTTY) rl.prompt();
  for await (const rawLine of rl) {
    if (!running) break;
    const line = String(rawLine).trim();
    if (!line) {
      if (process.stdin.isTTY) rl.prompt();
      continue;
    }

    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.split(/\s+/);
      const arg = rest.join(" ");
      await brain.settle(); // 调试命令读的是库里的状态，先排空后台任务
      switch (cmd) {
        case "/help":
          console.log(
            [
              "",
              "  对话与状态",
              "  /state       当前需求（含张力）、情绪、上一拍被压制的动机",
              "  /cards [n]   最近的卡片（时间/状态/关键词/强度/所在线）",
              "  /loops       未了之事（含「试过几次没成」）",
              "  /why         上一轮的提示词分区（调人格就看这个）",
              "  /sys         表达层的 system 提示词（人格内核）",
              "",
              "  记忆调试",
              "  /mem <话>    试探：这句话会召回哪些卡片（只读，不改库、无随机）",
              "  /expand <id> 翻某张卡片的原始记录",
              "  /links <id>  这张卡片声明过/被声明过的因果",
              "  /status <id> <active|expired|retracted|uncertain>  手工改正状态",
              "  /expire      预览哪些卡片现在该按时间失效；加 --apply 真的执行",
              "",
              "  观测",
              "  /audit       句数/禁语/复述的合规统计（不需要 judge 模型）",
              "  /recall      召回通道分布 + 被想起最多的卡片",
              "  /cost        token / 调用次数 / 延迟，按调用类型分组",
              "  /ticks       最近几拍动机决策",
              "",
              "  人物（v4）",
              "  /who         现在在跟谁说话：称呼、别名、我知道的、还不知道的",
              "  /alias <id> <称呼>   手工加一个别名",
              "  /awake       最近的唤醒记录（谁在、问过没有）",
              "",
              "  维护",
              "  /sleep       立刻跑一次巩固（合并/串线/写演变/时间过期/清日志）",
              "  /purge       清掉 mock 期间写下的卡片",
              "  /reseed      用 persona/ 重新编译人设",
              "  /quit        退出",
              "",
            ].join("\n"),
          );
          break;

        case "/state": {
          const s = brain.stats();
          console.log(`\n${C.bold("需求")}\n${needsTable(s.state.needs)}`);
          console.log(
            `\n${C.bold("情绪")} 效价 ${s.state.affect.v.toFixed(2)} · 唤醒 ${s.state.affect.a.toFixed(2)} · 支配 ${s.state.affect.d.toFixed(2)}`,
          );
          if (s.lastRejected.length > 0) {
            console.log(`\n${C.bold("被压制的动机")}`);
            for (const r of s.lastRejected) console.log(C.dim(`  ${r.intent} (${r.score.toFixed(2)})  ${r.reason}`));
          }
          console.log();
          break;
        }

        case "/cards": {
          const n = Number(arg) || 12;
          const rows = liveCards(env.db, n);
          console.log();
          for (const r of rows) {
            const kw = JSON.parse(r.keywords ?? "[]").join("/");
            const st = r.status === "active" ? "" : C.yellow(`〔${STATUS_MARK[r.status] ?? r.status}〕`);
            const line = r.thread_id ? C.dim(` 线#${r.thread_id}`) : "";
            const bad = r.confidence < 0.6 ? C.dim(" 不太准") : "";
            console.log(
              `  ${C.dim(`#${String(r.id).padEnd(4)}`)} ${C.dim(`[${r.kind}]`)} ${st}${r.title}  ` +
                C.dim(`${fuzzyTime(r.event_at)}${kw ? ` ⟨${kw}⟩` : ""} 强度${r.strength.toFixed(2)}`) +
                line +
                bad,
            );
          }
          if (rows.length === 0) console.log(C.dim("  还没有卡片。先说几句话。"));
          console.log();
          break;
        }

        case "/mem": {
          if (!arg) {
            console.log(C.dim("  用法：/mem 上周说的那个项目\n"));
            break;
          }
          const hits = await brain.recallProbe(arg);
          console.log();
          if (hits.length === 0) console.log(C.dim("  什么也没想起来。\n"));
          for (const h of hits) {
            const st = h.status === "active" ? "" : C.yellow(`〔${STATUS_MARK[h.status] ?? h.status}〕`);
            console.log(
              `  ${C.cyan(h.score.toFixed(3))} ${C.dim(`[${h.channel}]`)} ${C.dim(h.time_label)} ${st}${h.title}` +
                (h.fromThread ? C.dim("  ↳前后变化") : ""),
            );
          }
          console.log();
          break;
        }

        case "/expand": {
          const id = Number(arg);
          if (!id) {
            console.log(C.dim("  用法：/expand 12\n"));
            break;
          }
          const slice = expandCard(env, id, env.cfg.recall.expandLines);
          console.log();
          if (!slice) {
            console.log(C.dim("  这张卡片没有对应的原始记录。\n"));
            break;
          }
          for (const l of slice.lines) {
            // 格式约定见 shared/dialogue.ts：我说的带「我」，他说的不带标注
            console.log(
              l.role === "user" ? `  ${l.content}` : `  ${C.cyan("我")}：${l.content}`,
            );
          }
          console.log();
          break;
        }

        case "/loops": {
          const loops = listOpenLoops(env.db, 10);
          console.log();
          if (loops.length === 0) console.log(C.dim("  没有悬着的事。"));
          for (const l of loops) {
            const esc = l.escalation > 0 ? C.yellow(` 试过${l.escalation}次`) : "";
            console.log(
              `  ${C.dim(`#${l.id}`)} ${l.text}  ${C.dim(`紧急${l.urgency.toFixed(2)} 提过${l.mentioned_count}次 ${fuzzyTime(l.created_at)}`)}${esc}`,
            );
          }
          console.log();
          break;
        }

        case "/links": {
          const id = Number(arg);
          if (!id) {
            console.log(C.dim("  用法：/links 12\n"));
            break;
          }
          const card = getCards(env.db, [id])[0];
          const links = linksOfCard(env.db, id);
          console.log();
          console.log(`  ${C.bold(`#${id}`)} ${card?.title ?? "（没有这张卡片）"}`);
          if (links.length === 0) console.log(C.dim("  没有任何声明过的因果。"));
          for (const l of links) {
            const out = l.from_id === id;
            const other = out ? l.to_id : l.from_id;
            const otherCard = getCards(env.db, [other])[0];
            const arrow = out ? "→" : "←";
            console.log(
              `  ${C.dim(arrow)} ${C.cyan(`#${other}`)} ${C.dim(`[${l.relation}]`)} ${otherCard?.title ?? "（已删除）"}`,
            );
          }
          console.log();
          break;
        }

        case "/status": {
          const [idArg, to] = arg.split(/\s+/);
          const id = Number(idArg);
          const allowed = ["active", "expired", "retracted", "uncertain"];
          if (!id || !to || !allowed.includes(to)) {
            console.log(C.dim(`  用法：/status 12 expired   （可选：${allowed.join(" / ")}）\n`));
            break;
          }
          const ok = forceStatus(env, id, to, Date.now());
          console.log(C.dim(ok ? `  #${id} 已改为 ${to}（记进了 card_status_log）\n` : `  没有 #${id} 这张卡片\n`));
          break;
        }

        case "/expire": {
          const apply = arg.includes("--apply");
          if (apply) {
            const rep = refreshStatuses(env, Date.now());
            console.log(C.dim(`  扫了 ${rep.scanned} 张，令 ${rep.expired} 张失效。\n`));
            for (const t of rep.transitions) console.log(`  ${C.dim(`#${t.cardId}`)} ${t.title}  ${C.dim(t.reason)}`);
          } else {
            const list = previewExpirations(env, Date.now());
            console.log();
            if (list.length === 0) console.log(C.dim("  按现在的时钟，没有该失效的卡片。"));
            for (const t of list) console.log(`  ${C.dim(`#${t.cardId}`)} ${t.title}  ${C.yellow(t.reason)}`);
            if (list.length > 0) console.log(C.dim("\n  加 --apply 真的执行。"));
          }
          console.log();
          break;
        }

        case "/audit": {
          const since = Date.now() - 7 * 86_400_000;
          const rows = auditStats(env.db, since);
          const hist = violationHistogram(env.db, since);
          console.log();
          if (rows.length === 0) {
            console.log(C.dim("  近 7 天没有记录。"));
          }
          for (const r of rows) {
            const turns = Number(r.turns);
            const silent = Number(r.silent ?? 0);
            const over = Number(r.over_limit ?? 0);
            const retried = Number(r.retried ?? 0);
            const fixed = Number(r.fixed ?? 0);
            const breaks = Number(r.breaks ?? 0);
            console.log(
              C.bold(`  ${r.kind}`) +
                C.dim(
                  `  ${turns} 轮 · 沉默 ${silent}（${((silent / Math.max(1, turns)) * 100).toFixed(0)}%）· ` +
                    `平均 ${Number(r.avg_sentences ?? 0).toFixed(1)} 句 · 超句数 ${over} · ` +
                    `复述均值 ${Number(r.avg_repeat ?? 0).toFixed(2)}`,
                ),
            );
            console.log(
              C.dim(`        违规重说 ${retried} 次（改好 ${fixed}）· 演不出来 ${breaks} 次`),
            );
          }
          if (hist.length > 0) {
            console.log(`\n${C.bold("  违规分布")}`);
            for (const h of hist) console.log(C.dim(`    ${h.code}: ${h.n}`));
          }
          console.log();
          break;
        }

        case "/recall": {
          const since = Date.now() - 7 * 86_400_000;
          const st = recallStats(env.db, since);
          console.log();
          console.log(C.bold(`  近 7 天召回 ${st.total} 次`));
          for (const c of st.channels) {
            console.log(
              C.dim(
                `    ${c.channel.padEnd(7, " ")} ${String(c.n).padStart(4)} 次  均分 ${Number(c.avg_score ?? 0).toFixed(3)}  翻原话 ${c.expanded ?? 0}`,
              ),
            );
          }
          if (st.topCards.length > 0) {
            console.log(`\n${C.bold("  被想起最多的")}`);
            for (const t of st.topCards) {
              console.log(C.dim(`    #${String(t.card_id).padEnd(4)} ${t.n} 次  ${t.title ?? "（已删除）"}`));
            }
          }
          console.log();
          break;
        }

        case "/cost": {
          const since = Date.now() - 7 * 86_400_000;
          const rows = costStats(env.db, since);
          console.log();
          if (rows.length === 0) console.log(C.dim("  近 7 天没有调用。"));
          let tin = 0;
          let tout = 0;
          let calls = 0;
          for (const r of rows) {
            tin += Number(r.tokens_in ?? 0);
            tout += Number(r.tokens_out ?? 0);
            calls += Number(r.calls);
            console.log(
              C.dim(
                `  ${r.kind.padEnd(14, " ")} ${String(r.calls).padStart(5)} 次  ` +
                  `入 ${String(r.tokens_in ?? 0).padStart(7)} / 出 ${String(r.tokens_out ?? 0).padStart(6)} tok  ` +
                  `均 ${Number(r.avg_ms ?? 0).toFixed(0)}ms  错误 ${r.errors ?? 0}`,
              ),
            );
          }
          if (calls > 0) {
            console.log(C.dim(`\n  合计 ${calls} 次 · 入 ${tin} tok · 出 ${tout} tok`));
            console.log(C.dim(`  平均每轮 ≈ ${(tin / calls).toFixed(0)} tok 入`));
          }
          console.log();
          break;
        }

        case "/why": {
          const r = brain.lastTurn;
          if (!r) {
            console.log(C.dim("  还没说过话。\n"));
            break;
          }
          console.log();
          for (const s of r.prompt.sections) {
            console.log(C.bold(`  ── ${s.name}`));
            console.log(
              s.text
                .split("\n")
                .map((l) => `     ${l}`)
                .join("\n"),
            );
          }
          console.log();
          break;
        }

        case "/sys": {
          console.log();
          console.log(env.persona.system);
          console.log(
            C.dim(`\n  —— 共 ${env.persona.system.length} 字，hash ${env.persona.hash}（跨轮不变，走 prompt cache）\n`),
          );
          break;
        }

        case "/sleep": {
          console.log(C.dim("  巩固中…"));
          const rep = await consolidate(env, Date.now());
          console.log(
            [
              "",
              `  卡片 ${rep.liveBefore} → ${rep.liveAfter} 张`,
              `  字面重复合并 ${rep.merged} 组 · 模型判定合并 ${rep.llmMerged} 组`,
              `  串线 ${rep.threadsFormed} 条 · 重写演变 ${rep.threadsSummarized} 条`,
              `  按时间失效 ${rep.statusExpired} 张 · 过期未了之事归档 ${rep.expiredLoops} 条`,
              `  清理日志 召回 ${rep.prunedRecall} / 调用 ${rep.prunedPrompt} 行`,
              `  印象更新 ${rep.personUpdated ? "是" : "否"} · 自我叙事升版 ${rep.selfSheetBumped ? "是" : "否"}`,
              ...rep.notes.map((n) => `  · ${n}`),
              "",
            ].join("\n"),
          );
          break;
        }

        case "/purge": {
          const n = purgeMockCards(env);
          console.log(C.dim(`  清掉 ${n} 张 mock 卡片。\n`));
          break;
        }

        case "/reseed": {
          const { seedPersona } = await import("../express/persona.ts");
          const r = seedPersona(env.db, Date.now(), { force: true });
          clearPromptCache();
          console.log(C.dim(`  人设已重编译：v${r.version}\n`));
          break;
        }

        case "/ticks": {
          const t = recentTickLog(env.db, 5);
          console.log();
          for (const row of t) {
            console.log(`  ${row.chosen_intent ?? C.dim("沉默")}  ${C.dim((row.rejected ?? "").slice(0, 120))}`);
          }
          console.log();
          break;
        }

        case "/who": {
          const persons = allPersons(env.db);
          console.log();
          for (const p of persons) {
            const names = aliasesOf(env.db, p.id).map((a) => a.alias);
            const badge =
              p.dossier_status === "known"
                ? C.green("知道是谁")
                : p.dossier_status === "provisional"
                  ? C.yellow("只知道个叫法")
                  : C.dim("不知道是谁");
            console.log(`  ${C.bold(`#${p.id}`)} ${p.display_name ?? p.name}  ${badge}`);
            if (names.length > 0) console.log(C.dim(`      别名：${names.join("、")}`));
            console.log(C.dim(`      亲近感 ${p.closeness.toFixed(2)} · 信任 ${p.trust.toFixed(2)} · 问过 ${p.asked_count}/${MAX_ASKS} 次`));
            if (p.traits) {
              try {
                const t = JSON.parse(p.traits) as { trait: string }[];
                for (const x of t.slice(0, 5)) console.log(C.dim(`      · ${x.trait}`));
              } catch {
                /* 坏行跳过 */
              }
            }
          }
          console.log();
          break;
        }

        case "/alias": {
          const [idArg, ...nameParts] = arg.split(/\s+/);
          const id = Number(idArg);
          const name = nameParts.join(" ").trim();
          if (!id || !name) {
            console.log(C.dim("  用法：/alias 1 开发者\n"));
            break;
          }
          if (!getPerson(env.db, id)) {
            console.log(C.dim(`  没有 #${id} 这个人。\n`));
            break;
          }
          const added = addAlias(env.db, id, name, { kind: "name", confidence: 1, now: Date.now() });
          console.log(C.dim(added ? `  #${id} 多了个别名：${name}\n` : `  ${name} 已经是 #${id} 的别名了。\n`));
          break;
        }

        case "/awake": {
          const rows = recentAwakenings(env.db, 10);
          console.log();
          if (rows.length === 0) console.log(C.dim("  还没有唤醒记录。"));
          for (const a of rows) {
            const who = a.person_name ? C.cyan(a.person_name) : C.dim("（不知道是谁）");
            const asked = a.asked_identity ? C.yellow(" 问过") : "";
            const called = a.called_as ? C.dim(` 他叫我「${a.called_as}」`) : "";
            console.log(`  ${C.dim(fuzzyTime(a.at, Date.now()))}  ${a.mode === "cold_start" ? "第一次" : "又醒了"}  ${who}${asked}${called}`);
          }
          console.log();
          break;
        }

        case "/quit":
        case "/exit":
          running = false;
          break;

        default:
          console.log(C.dim(`  不认识的命令：${cmd}（/help）\n`));
      }
      if (running && process.stdin.isTTY) rl.prompt();
      continue;
    }

    try {
      await brain.settle();
      const r = await brain.turn(line);
      printTurn(r);
    } catch (e) {
      console.error(C.red(`  [出错] ${(e as Error).message}\n`));
    }
    if (running && process.stdin.isTTY) rl.prompt();
  }

  clearInterval(timer);
  rl.close();
  await brain.settle();
  // v3：正常退出也把这一段 episode 收尾（v2 只在超时换段时关，
  // 手动退出会留下一个 ended_at 永远为 NULL 的段）
  brain.close();
  console.log(C.dim("\n  记忆已落盘。\n"));
  env.close();
}

main().catch((e) => {
  // 人设文件写错是最常见的启动失败原因，此时堆栈毫无意义 —— 只要说清哪个文件、怎么改
  if (e instanceof PersonaError) {
    const C2 = (s: string) => `\x1b[31m${s}\x1b[0m`;
    const D = (s: string) => `\x1b[2m${s}\x1b[0m`;
    console.error(`\n  ${C2("人设文件有问题，启动中止")}\n`);
    for (const line of e.message.split("\n")) console.error(`  ${line}`);
    if (e.hint) {
      console.error("");
      for (const line of e.hint.split("\n")) console.error(`  ${D(line)}`);
    }
    console.error("");
    process.exit(1);
  }
  console.error(e);
  process.exit(1);
});

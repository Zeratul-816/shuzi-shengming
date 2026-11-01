import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEnv } from "../src/env.ts";
import { assemble } from "../src/express/assemble.ts";
import { activeSelfSheet, addTrace, openEpisode, primaryPerson } from "../src/store/repos.ts";
import { DIALOGUE_FORMAT_NOTE, renderDialogue, renderDialogueLine } from "../src/shared/dialogue.ts";

/**
 * 格式约定（用户定的）：
 *   我说的 `我：……`
 *   他说的 `……`       ← 什么都没有
 * 这条测试的作用不是"验证功能"，是**防止格式漂移**。
 * 只要有一处渲染口拼回「他：」或「用户：」，模型就会开始模仿那种标签体。
 */
test("对话渲染：我说的带「我：」，他说的不带任何标注", () => {
  assert.equal(renderDialogueLine("me", "嗯。"), "我：嗯。");
  assert.equal(renderDialogueLine("user", "今天很累"), "今天很累");
  assert.equal(
    renderDialogue([
      { role: "user", content: "今天很累" },
      { role: "me", content: "嗯。" },
      { role: "user", content: "你不问问为什么" },
    ]),
    "今天很累\n我：嗯。\n你不问问为什么",
  );
});

test("非对话角色不会被静默吞掉（system/tool 必须还看得出是谁）", () => {
  // 宁可难看，也不要让一句系统消息被当成"他说的"
  assert.equal(renderDialogueLine("system", "重启完成"), "system：重启完成");
  assert.equal(renderDialogueLine("tool", "读文件"), "tool：读文件");
});

test("提示词里不出现「他：」「用户：」这类第三人称标签", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-dlg-"));
  const env = createEnv({ dbPath: path.join(dir, "t.db"), dataDir: dir, provider: "mock" });
  const now = Date.now();
  const person = primaryPerson(env.db, now);
  const ep = openEpisode(env.db, now, "system", "t");
  addTrace(env.db, { episodeId: ep, ts: now - 2000, role: "user", content: "今天上线又崩了" });
  addTrace(env.db, { episodeId: ep, ts: now - 1000, role: "me", content: "又是那个报错吗。" });
  addTrace(env.db, { episodeId: ep, ts: now - 500, role: "user", content: "嗯，同一个" });

  const p = assemble(env, {
    now,
    person,
    self: activeSelfSheet(env.db),
    card: {
      intent: "reply",
      drive: "connection",
      urgency: 0.5,
      why: "他在跟我说话。",
      desired_outcome: "接住",
      must_include: [],
      must_not: [],
      tone: "自然",
      max_sentences: 3,
      seed_card_ids: [],
      attempt: 0,
    },
    cards: [],
    recent: [
      { id: 1, episode_id: ep, ts: now - 2000, role: "user", content: "今天上线又崩了", meta: null },
      { id: 2, episode_id: ep, ts: now - 1000, role: "me", content: "又是那个报错吗。", meta: null },
      { id: 3, episode_id: ep, ts: now - 500, role: "user", content: "嗯，同一个", meta: null },
    ],
    loops: [],
    currentUtterance: "还在查吗",
  });

  const recent = p.sections.find((s) => s.name === "recent")!;
  assert.ok(recent.text.includes("我：又是那个报错吗。"), `我的行要有标注：\n${recent.text}`);
  assert.ok(recent.text.includes("今天上线又崩了"), "他的话要在");
  assert.ok(recent.text.includes("\n嗯，同一个"), "他的话要裸着单独一行");

  assert.ok(!p.user.includes("他："), "提示词里不该有「他：」");
  assert.ok(!p.user.includes("用户："), "提示词里不该有「用户：」");
  // 格式说明必须真的进了提示词，否则模型得靠猜
  assert.ok(p.user.includes(DIALOGUE_FORMAT_NOTE), "格式说明要进提示词");

  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("翻出来的原话用同一个格式（两段式回忆的渲染口不能漂）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-dlg2-"));
  const env = createEnv({ dbPath: path.join(dir, "t.db"), dataDir: dir, provider: "mock" });
  const now = Date.now();
  const p = assemble(env, {
    now,
    person: primaryPerson(env.db, now),
    self: activeSelfSheet(env.db),
    card: {
      intent: "reply",
      drive: "connection",
      urgency: 0.5,
      why: "",
      desired_outcome: "",
      must_include: [],
      must_not: [],
      tone: "",
      max_sentences: 3,
      seed_card_ids: [],
      attempt: 0,
    },
    cards: [],
    recent: [],
    loops: [],
    currentUtterance: "你还记得吗",
    details: [
      {
        cardId: 7,
        lines: [
          { role: "user", content: "我下周要搬家", ts: now - 1000 },
          { role: "me", content: "搬去哪。", ts: now - 500 },
        ],
      },
    ],
  });
  const details = p.sections.find((s) => s.name === "details")!;
  assert.ok(details.text.includes("我：搬去哪。"), `\n${details.text}`);
  assert.ok(details.text.includes("\n我下周要搬家"), "他的原话裸着");
  assert.ok(!details.text.includes("他："));
  env.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

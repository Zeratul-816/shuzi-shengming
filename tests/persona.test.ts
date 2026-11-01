import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPersona, PersonaError } from "../src/express/persona.ts";

/** 造一个临时人设目录，并把 DH_PERSONA_DIR 指过去 */
function withPersona(files: Record<string, string>): { dir: string; restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-persona-"));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body, "utf8");
  const prev = process.env.DH_PERSONA_DIR;
  process.env.DH_PERSONA_DIR = dir;
  return {
    dir,
    restore: () => {
      if (prev === undefined) delete process.env.DH_PERSONA_DIR;
      else process.env.DH_PERSONA_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const VOICE_OK = JSON.stringify({
  positive: ["说完就停。"],
  negative: ["不复述对方的话。"],
  banned_phrases: ["作为一个人工智能"],
  examples_good: ["嗯。"],
  examples_bad: ["很高兴能帮到你！"],
});

test("正常人设：能编译出 system 与稳定 hash", () => {
  const ctx = withPersona({ "identity.md": "# 我是谁\n\n我是个安静的旁观者。", "voice.json": VOICE_OK });
  try {
    const p = loadPersona();
    assert.ok(p.system.includes("安静的旁观者"));
    assert.ok(p.system.includes("不复述对方的话"));
    assert.equal(p.hash.length, 12);
    assert.equal(loadPersona().hash, p.hash, "同一份人设 hash 应稳定");
  } finally {
    ctx.restore();
  }
});

test("末尾多逗号：报出具体行号，而不是 SyntaxError 堆栈", () => {
  const bad = `{
  "positive": [
    "说完就停。",
    "不确定就说不确定。",
  ],
  "negative": ["不复述对方的话。"]
}`;
  const ctx = withPersona({ "identity.md": "# 我\n\n人设。", "voice.json": bad });
  try {
    let err: unknown;
    try {
      loadPersona();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof PersonaError, `应抛 PersonaError，实际 ${String(err)}`);
    const pe = err as PersonaError;
    assert.match(pe.message, /逗号/, `消息应点明是逗号问题：${pe.message}`);
    assert.match(pe.message, /第 4 行/, `逗号在第 4 行末尾，消息应指出：${pe.message}`);
    assert.ok(pe.hint.length > 0, "应带可执行的修改提示");
  } finally {
    ctx.restore();
  }
});

test("字段类型写错：指出是哪个字段", () => {
  const bad = JSON.stringify({ positive: [123], negative: [] });
  const ctx = withPersona({ "identity.md": "# 我\n\n人设。", "voice.json": bad });
  try {
    let err: unknown;
    try {
      loadPersona();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof PersonaError);
    assert.match((err as PersonaError).message, /positive/, `应指出字段名：${(err as PersonaError).message}`);
  } finally {
    ctx.restore();
  }
});

test("单个字符串会被自动包成数组（手写时常见的偷懒写法）", () => {
  const loose = JSON.stringify({ positive: "说完就停。", negative: "不复述对方的话。" });
  const ctx = withPersona({ "identity.md": "# 我\n\n人设。", "voice.json": loose });
  try {
    const p = loadPersona();
    assert.ok(p.system.includes("说完就停"));
    assert.ok(p.system.includes("不复述对方的话"));
  } finally {
    ctx.restore();
  }
});

test("带 BOM 的文件也能读（记事本/PowerShell 常见）", () => {
  const ctx = withPersona({
    "identity.md": "\uFEFF# 我\n\n带 BOM 的人设。",
    "voice.json": `\uFEFF${VOICE_OK}`,
  });
  try {
    const p = loadPersona();
    assert.ok(p.system.includes("带 BOM 的人设"));
  } finally {
    ctx.restore();
  }
});

test("identity.md 缺失：提示去备份目录找", () => {
  const ctx = withPersona({ "voice.json": VOICE_OK });
  try {
    // 造一个备份子目录，模拟"把旧人设放进 persona/白模/"
    fs.mkdirSync(path.join(ctx.dir, "白模"));
    fs.writeFileSync(path.join(ctx.dir, "白模", "identity.md"), "# 备份", "utf8");

    let err: unknown;
    try {
      loadPersona();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof PersonaError);
    const pe = err as PersonaError;
    assert.match(pe.message, /identity\.md/);
    assert.match(pe.hint, /白模/, `应指路到备份目录：${pe.hint}`);
  } finally {
    ctx.restore();
  }
});

test("空文件也会被拦住", () => {
  const ctx = withPersona({ "identity.md": "   \n\n", "voice.json": VOICE_OK });
  try {
    assert.throws(() => loadPersona(), (e: unknown) => e instanceof PersonaError && /空文件/.test((e as Error).message));
  } finally {
    ctx.restore();
  }
});

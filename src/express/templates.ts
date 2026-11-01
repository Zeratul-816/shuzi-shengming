/**
 * 提示词文件加载 + 极简模板渲染。
 *
 * 为什么提示词是 .md 文件而不是代码里的字符串：
 *   调人格 90% 的时间在改提示词。文件可以不重启就热改（loadPrompt 有缓存，
 *   改完调用 clearPromptCache() 或重进 /reseed），也不用重新格式化代码。
 *
 * 渲染语法只有一种：{{KEY}} → vars[KEY]，未提供的键渲染成空串（不会抛错）。
 * 刻意不支持条件/循环：模板一旦有逻辑，你就得写测试来验证提示词，
 * 而提示词的正确性只能靠读。逻辑留在 TypeScript 里。
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const PROMPT_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));
const cache = new Map<string, string>();

/** 读 src/prompts/*.md，带缓存。改提示词重启即可，不需要构建。 */
export function loadPrompt(name: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const file = `${PROMPT_DIR}${name}.md`;
  const text = fs.readFileSync(file, "utf8");
  cache.set(name, text);
  return text;
}

export function clearPromptCache(): void {
  cache.clear();
}

/** 极简模板：{{KEY}} → vars[KEY]，未提供的键渲染为空串 */
export function render(tpl: string, vars: Record<string, string | number | undefined>): string {
  return tpl.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

export function bullet(items: string[], prefix = "- "): string {
  return items.map((i) => `${prefix}${i}`).join("\n");
}

export function numbered(items: string[]): string {
  return items.map((i, idx) => `${idx + 1}. ${i}`).join("\n");
}

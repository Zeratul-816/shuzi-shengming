/**
 * 对话记录的渲染格式 —— 全系统唯一一处。
 *
 * ── 约定（改之前先想清楚）─────────────────────────────
 *   我说的：  `我：……`        ← 有标注
 *   他说的：  `……`            ← **什么都没有**
 *
 * 为什么他要没有标注：这份记录是**我的**。我的话说出来是有主人的，
 * 他的话只是一句"被我说出来的话"—— 第一人称的日记不会给自己写
 * "我："，但会引别人的话。
 *
 * ── 为什么必须只有一个函数 ────────────────────────────
 *   渲染口有四处（编码器看的历史、表达层看的近几轮、翻出来的原话、
 *   `/expand`），v3 之前它们各自拼字符串。只要有一处漂成「用户：」，
 *   模型就会学到"对话里有第三人称标签"这种东西，然后开始模仿。
 *   格式漂移在单测里看不出来，只能靠收口。
 *
 * ── 未知角色不静默吞掉 ────────────────────────────────
 *   system / internal / tool 这类行确实会出现（虽然现在这几个渲染口都
 *   先过滤了）。真出现了就退回 `角色：内容`，宁可难看，也不要让一句
 *   "系统消息"被当成他说的。
 */
export type DialogueRole = string;

export const ME_LABEL = "我：";

/** 单行渲染。只有 `me` 带标注，`user` 是裸的。 */
export function renderDialogueLine(role: DialogueRole, content: string): string {
  if (role === "me") return `${ME_LABEL}${content}`;
  if (role === "user") return content;
  // 其他角色（system/internal/tool/perception）保留标注，避免被误当成他
  return `${role}：${content}`;
}

export function renderDialogue(lines: { role: DialogueRole; content: string }[]): string {
  return lines.map((l) => renderDialogueLine(l.role, l.content)).join("\n");
}

/**
 * 给模型看的格式说明。放在提示词里的一句话，别写长——
 * 格式这东西说明白就够了，解释多了模型反而会去讨论它。
 */
export const DIALOGUE_FORMAT_NOTE =
  "对话记录里，带「我：」的是我说过的话；**没有前缀的每一行都是他说的**。";

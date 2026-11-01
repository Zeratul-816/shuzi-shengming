/**
 * 时间渲染：把时间戳变成"人会说的时间"，用于提示词里的记忆时间锚。
 *
 * 为什么不用绝对时间：写「2026-02-11 23:04」时模型的反应是"读取一条记录"，
 * 写「昨天晚上」时才是"想起一件事"。这一处措辞对观感的影响比想象的大。
 *
 * 粒度故意很粗（刚才 / N 分钟前 / 昨天+时段 / N 天前 / 上周 / N 个月前）。
 * 太精确反而不像记忆，而且会诱导模型去算时间差、说出"已经过去 3 天 14 小时"这种话。
 */
export function fuzzyTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const diff = now - ts;
  const dayMs = 86_400_000;
  const days = Math.floor(diff / dayMs);

  const hh = d.getHours();
  const daypart = hh < 5 ? "凌晨" : hh < 9 ? "早上" : hh < 12 ? "上午" : hh < 14 ? "中午" : hh < 18 ? "下午" : hh < 23 ? "晚上" : "深夜";

  if (diff < 60_000) return "刚才";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (days === 0) return `${daypart}${diff < 6 * 3_600_000 ? "早些时候" : ""}`.trim();
  if (days === 1) return `昨天${daypart}`;
  if (days === 2) return `前天${daypart}`;
  if (days < 7) return `${days} 天前`;
  if (days < 14) return "上周";
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return d.getFullYear() === n.getFullYear() ? `${Math.floor(days / 30)} 个月前` : "更早以前";
}


/**
 * 时间解析：把中文里的时间词变成时间窗，供"时间通道"检索使用。
 *
 * 为什么不用 LLM 解析：这层每轮都要跑，规则能覆盖日常说法的绝大多数，
 * 而且错了很容易查（打一行日志就能看出时间窗取错没有）。LLM 留给"事件发生在
 * 什么时候"那一侧 —— 那里由提炼模型直接给 event_at_iso，更准。
 *
 * 注意：这里只做**粗粒度**解析。宁可窗口宽一点，也不要窄到漏掉想找的记忆。
 */
export interface TimeWindow {
  from: number;
  to: number;
  label: string;
}

const DAY = 86_400_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 从一句话里找时间窗。命中越具体的说法越优先。 */
export function parseTimeHint(text: string, now = Date.now()): TimeWindow | null {
  const today = startOfDay(now);
  const t = text;

  if (/(今天|今日|刚才|方才)/.test(t)) return { from: today, to: now, label: "今天" };
  if (/(昨天|昨日|昨晚|昨夜)/.test(t)) return { from: today - DAY, to: today, label: "昨天" };
  if (/(前天)/.test(t)) return { from: today - 2 * DAY, to: today - DAY, label: "前天" };
  if (/(大前天)/.test(t)) return { from: today - 3 * DAY, to: today - 2 * DAY, label: "大前天" };

  const nDaysAgo = /(\d+)\s*天前/.exec(t);
  if (nDaysAgo) {
    const n = Number(nDaysAgo[1]);
    return { from: today - n * DAY, to: today - (n - 1) * DAY, label: `${n} 天前` };
  }

  if (/(上周|上个星期|上星期|上礼拜)/.test(t)) return { from: today - 14 * DAY, to: today - 7 * DAY, label: "上周" };
  if (/(这周|本周|这个星期)/.test(t)) return { from: today - 7 * DAY, to: now, label: "这周" };
  if (/(上个月|上月)/.test(t)) return { from: today - 60 * DAY, to: today - 30 * DAY, label: "上个月" };

  if (/(最近|这几天|近期|前阵子|前几天)/.test(t)) return { from: today - 7 * DAY, to: now, label: "最近" };
  if (/(那阵子|那时候|有一次|之前有一)/.test(t)) return { from: today - 90 * DAY, to: now, label: "那阵子" };
  if (/(以前|当初|很久以前|早前)/.test(t)) return { from: 0, to: today - 90 * DAY, label: "很久以前" };

  return null;
}

/**
 * 把模型给的 event_at_iso 解析成时间戳。
 * 容忍 "2026-02-10" / "2026-02-10T21:30" / "2026/02/10 21:30" / 只有小时的情况。
 * 解析不出来就返回 null，由调用方退化成 created_at + vague。
 */
export function parseEventAt(iso: string | undefined, fallback: number): { at: number; precision: "exact" | "day" | "week" | "month" | "vague" } {
  if (!iso) return { at: fallback, precision: "vague" };
  const s = iso.trim().replace(/\//g, "-").replace(" ", "T");
  const withTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (withTime) {
    const d = new Date(
      Number(withTime[1]),
      Number(withTime[2]) - 1,
      Number(withTime[3]),
      Number(withTime[4]),
      Number(withTime[5]),
    );
    if (!Number.isNaN(d.getTime())) return { at: d.getTime(), precision: "exact" };
  }
  const dayOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dayOnly) {
    const d = new Date(Number(dayOnly[1]), Number(dayOnly[2]) - 1, Number(dayOnly[3]), 12, 0);
    if (!Number.isNaN(d.getTime())) return { at: d.getTime(), precision: "day" };
  }
  return { at: fallback, precision: "vague" };
}

/** 时间窗是否与卡片的时间精度相容（粗精度卡片放宽匹配） */
export function windowTolerance(precision: string): number {
  switch (precision) {
    case "exact":
      return 0;
    case "day":
      return 6 * 3_600_000;
    case "week":
      return 2 * DAY;
    case "month":
      return 8 * DAY;
    default:
      return 14 * DAY;
  }
}

export function inWindow(at: number, win: { from: number; to: number }, precision: string): boolean {
  const tol = windowTolerance(precision);
  return at >= win.from - tol && at <= win.to + tol;
}

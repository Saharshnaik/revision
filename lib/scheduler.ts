export const DEFAULT_INTERVALS = [1, 3, 7, 14, 30, 60, 120, 240, 360, 540, 720];

export function toDateOnly(input: string | Date): string {
  const date = typeof input === "string" ? new Date(input) : new Date(input);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function todayString(): string {
  return toDateOnly(new Date());
}

export function addDays(dateOnly: string, days: number): string {
  const [y, m, d] = dateOnly.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function compareDateStrings(a: string, b: string): number {
  return a.localeCompare(b);
}

export function normalizeIntervals(value: unknown): number[] {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? "")
        .split(",")
        .map((n) => n.trim());
  const set = new Set<number>();
  for (const item of raw) {
    const n = typeof item === "number" ? item : Number(item);
    if (Number.isFinite(n) && n > 0) set.add(Math.floor(n));
  }
  const arr = Array.from(set).sort((a, b) => a - b);
  return arr.length ? arr : DEFAULT_INTERVALS;
}

export function buildPlannedDates(startDate: string, intervals: number[], stageIndex = 0): string[] {
  const safe = intervals.length ? intervals : DEFAULT_INTERVALS;
  const out: string[] = [];
  for (let i = stageIndex; i < safe.length; i += 1) {
    out.push(addDays(startDate, safe[i]));
  }
  return out;
}

export function getNextDueDate(baseDate: string, currentStage: number, intervals: number[]): string {
  const safe = intervals.length ? intervals : DEFAULT_INTERVALS;
  const idx = Math.min(Math.max(currentStage, 0), safe.length - 1);
  return addDays(baseDate, safe[idx]);
}

export function elapsedDays(fromDate: string, toDate: string): number {
  const a = new Date(`${fromDate}T12:00:00`);
  const b = new Date(`${toDate}T12:00:00`);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 20);
}

export function tagsToText(tags: string[]): string {
  return tags.join(", ");
}

export function effectivePriority(
  item: {
    priority: number;
    carry_priority: number;
    next_due_date: string | null;
    created_date: string;
  },
  today: string
): number {
  const due = item.next_due_date ?? item.created_date;
  const overdue = due <= today ? elapsedDays(due, today) : 0;
  return item.priority + item.carry_priority + Math.max(0, overdue) * 2;
}

export function sortByDueAndPriority<
  T extends { next_due_date: string | null; priority: number; carry_priority: number; created_date: string }
>(items: T[], today: string): T[] {
  return [...items].sort((a, b) => {
    const ae = effectivePriority(a, today);
    const be = effectivePriority(b, today);
    if (be !== ae) return be - ae;
    const ad = a.next_due_date ?? a.created_date;
    const bd = b.next_due_date ?? b.created_date;
    if (ad !== bd) return ad.localeCompare(bd);
    return 0;
  });
}

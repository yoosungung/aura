export const HOUR_DAYS = [
  { key: "mon", label: "월" },
  { key: "tue", label: "화" },
  { key: "wed", label: "수" },
  { key: "thu", label: "목" },
  { key: "fri", label: "금" },
  { key: "sat", label: "토" },
  { key: "sun", label: "일" },
] as const;

export type HourDayKey = (typeof HOUR_DAYS)[number]["key"];

export type DayHours = {
  open: boolean;
  start: string;
  end: string;
};

export type HoursForm = {
  timezone: string;
  week: Record<HourDayKey, DayHours>;
};

const WEEKDAY: HourDayKey[] = ["mon", "tue", "wed", "thu", "fri"];

export function defaultWeek(): Record<HourDayKey, DayHours> {
  const week = {} as Record<HourDayKey, DayHours>;
  for (const day of HOUR_DAYS) {
    week[day.key] = {
      open: WEEKDAY.includes(day.key),
      start: "09:00",
      end: "18:00",
    };
  }
  return week;
}

export function defaultHours(): HoursForm {
  return { timezone: "Asia/Seoul", week: defaultWeek() };
}

function asObject(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  return {};
}

export function parseBusinessHours(raw: unknown): HoursForm {
  const out = defaultHours();
  const obj = asObject(raw);
  if (typeof obj.timezone === "string" && obj.timezone.trim()) {
    out.timezone = obj.timezone;
  }
  const week = obj.week;
  if (!week || typeof week !== "object" || Object.keys(week as object).length === 0) {
    return out;
  }
  const rows = week as Record<string, unknown>;
  for (const day of HOUR_DAYS) {
    if (!Object.prototype.hasOwnProperty.call(rows, day.key)) {
      out.week[day.key] = { open: false, start: "09:00", end: "18:00" };
      continue;
    }
    const slots = rows[day.key];
    const first = Array.isArray(slots) ? slots[0] : null;
    if (Array.isArray(first) && first[0] && first[1]) {
      out.week[day.key] = { open: true, start: String(first[0]), end: String(first[1]) };
    } else {
      out.week[day.key] = { open: false, start: "09:00", end: "18:00" };
    }
  }
  return out;
}

export function serializeBusinessHours(form: HoursForm): { timezone: string; week: Record<string, string[][]> } {
  const week: Record<string, string[][]> = {};
  for (const day of HOUR_DAYS) {
    const row = form.week[day.key];
    week[day.key] = row.open && row.start && row.end ? [[row.start, row.end]] : [];
  }
  return { timezone: form.timezone || "Asia/Seoul", week };
}

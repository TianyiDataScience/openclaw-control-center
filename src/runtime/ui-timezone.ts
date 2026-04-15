const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

export function normalizeUiTimeZone(input: string | undefined, fallback = "UTC"): string {
  const candidate = (input ?? "").trim() || fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback;
  }
}

export function formatTimestampForUi(
  value: string | undefined,
  timeZone: string,
  options: { includeSeconds?: boolean; fallback?: string } = {},
): string {
  const fallback = options.fallback ?? "-";
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return trimmed;
  const formatter = getFormatter(timeZone, options.includeSeconds === true);
  const parts = formatter.formatToParts(new Date(parsed));
  const values = new Map(parts.map((part) => [part.type, part.value] as const));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  const hour = values.get("hour");
  const minute = values.get("minute");
  const second = values.get("second");
  if (!year || !month || !day || !hour || !minute) return trimmed;
  return options.includeSeconds === true && second
    ? `${year}-${month}-${day} ${hour}:${minute}:${second}`
    : `${year}-${month}-${day} ${hour}:${minute}`;
}

export function formatDateForTimeZone(value: string | number | Date, timeZone: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  const formatter = getDateFormatter(timeZone);
  const parts = formatter.formatToParts(parsed);
  const values = new Map(parts.map((part) => [part.type, part.value] as const));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  if (!year || !month || !day) return "";
  return `${year}-${month}-${day}`;
}

function getFormatter(timeZone: string, includeSeconds: boolean): Intl.DateTimeFormat {
  const key = `${timeZone}:${includeSeconds ? "sec" : "min"}`;
  const cached = FORMATTER_CACHE.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: includeSeconds ? "2-digit" : undefined,
    hourCycle: "h23",
  });
  FORMATTER_CACHE.set(key, formatter);
  return formatter;
}

function getDateFormatter(timeZone: string): Intl.DateTimeFormat {
  const key = `${timeZone}:date`;
  const cached = FORMATTER_CACHE.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  FORMATTER_CACHE.set(key, formatter);
  return formatter;
}

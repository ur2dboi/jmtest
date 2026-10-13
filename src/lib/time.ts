/**
 * Philippine time helpers (Asia/Manila = UTC+8, no daylight saving).
 *
 * The plugin calls date_default_timezone_set('Asia/Manila') and pins the MySQL
 * session to +08:00. Because PH has no DST we can convert with a fixed offset,
 * which is both exact and dependency-free.
 */
export const PH_OFFSET_MS = 8 * 60 * 60 * 1000;

export type PhParts = {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
  h: number; // 0-23
  i: number; // 0-59
  s: number; // 0-59
};

export function toPhParts(input: Date | string | number | null | undefined): PhParts {
  const date = toDate(input) ?? new Date();
  const shifted = new Date(date.getTime() + PH_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    h: shifted.getUTCHours(),
    i: shifted.getUTCMinutes(),
    s: shifted.getUTCSeconds(),
  };
}

export function toDate(input: Date | string | number | null | undefined): Date | null {
  if (input == null || input === '') return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input === 'number') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Postgres may hand back "2026-10-13 00:01:00+08" style strings.
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * PHP date()-style formatter, always in Philippine time.
 * Supported tokens: Y y m d j t H h g i s A a M F   (t = days in month)
 */
export function phFormat(input: Date | string | number | null | undefined, format = 'M d, Y - g:i A'): string {
  const p = toPhParts(input);
  if (!toDate(input)) return '';
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  const out: string[] = [];
  for (const ch of format) {
    switch (ch) {
      case 'Y': out.push(String(p.y)); break;
      case 'y': out.push(pad(p.y % 100)); break;
      case 'm': out.push(pad(p.m)); break;
      case 'd': out.push(pad(p.d)); break;
      case 'j': out.push(String(p.d)); break;
      case 't': out.push(String(new Date(Date.UTC(p.y, p.m, 0)).getUTCDate())); break;
      case 'H': out.push(pad(p.h)); break;
      case 'h': out.push(pad(h12)); break;
      case 'g': out.push(String(h12)); break;
      case 'i': out.push(pad(p.i)); break;
      case 's': out.push(pad(p.s)); break;
      case 'A': out.push(p.h < 12 ? 'AM' : 'PM'); break;
      case 'a': out.push(p.h < 12 ? 'am' : 'pm'); break;
      case 'M': out.push(MONTHS_SHORT[p.m - 1]); break;
      case 'F': out.push(MONTHS_LONG[p.m - 1]); break;
      default: out.push(ch);
    }
  }
  return out.join('');
}

export const phNow = (): Date => new Date();

/** Current Philippine date as YYYY-MM-DD (used for ID expiry comparisons). */
export function phToday(): string {
  const p = toPhParts(new Date());
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** Current Philippine month key YYYY-MM (unilevel monthly LP period). */
export function phMonthKey(input: Date | string | number | null = new Date()): string {
  const p = toPhParts(input);
  return `${p.y}-${pad(p.m)}`;
}

export function phDateTimeString(input: Date | string | number | null = new Date()): string {
  const p = toPhParts(input);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.i)}:${pad(p.s)}`;
}

/**
 * Daily pairing capacity window: resets at 12:01 AM Philippine time.
 * Port of mlm_pairing_day_window(). Returns UTC instants that bound the
 * Philippine day the event belongs to.
 */
export function phPairingDayWindow(eventTime?: Date | string | number | null): { start: Date; end: Date } {
  const nowMs = (toDate(eventTime) ?? new Date()).getTime();
  const p = toPhParts(nowMs);
  // 00:01:00 PH on the event's PH calendar day, expressed as a UTC instant.
  const startUtcMs = Date.UTC(p.y, p.m - 1, p.d, 0, 1, 0) - PH_OFFSET_MS;
  // If the event happened before today's 00:01 reset, it belongs to yesterday's window.
  const start = nowMs < startUtcMs ? new Date(startUtcMs - 86_400_000) : new Date(startUtcMs);
  const end = new Date(start.getTime() + 86_400_000);
  return { start, end };
}

/** ISO string safe for Postgres timestamptz parameters. */
export function iso(d: Date | string | number | null | undefined): string | null {
  const date = toDate(d);
  return date ? date.toISOString() : null;
}

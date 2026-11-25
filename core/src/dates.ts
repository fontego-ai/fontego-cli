// How fontego writes a date or a time for a person, everywhere: in the time zone of the machine that prints it (TZ),
// written the same way whatever language that machine speaks, so a person reads their own clock and a table sorts as
// text. Dates and times, 24 hours, no month names, no AM or PM, no zone: 2026-11-22, 2026-11-22 17:55, 17:55:12.
// What a program reads (--json) stays as the API gives it: ISO 8601, in UTC.

const pad = (n: number) => String(n).padStart(2, "0");

/** A calendar date (2026-11-22) has no time of day, so no zone: it is the same day everywhere. */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parse(value: string | Date): Date | null {
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isFinite(d.getTime()) ? d : null;
}

const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 2026-11-22: the day in this machine's time zone. What isn't a date comes back as it was. */
export function localDate(value: string | Date): string {
  if (typeof value === "string" && CALENDAR_DATE.test(value)) return value;
  const d = parse(value);
  return d ? day(d) : String(value);
}

/** 2026-11-22 17:55: the day and the time (24 hours) in this machine's time zone. What isn't a date comes back as it was. */
export function localDateTime(value: string | Date): string {
  if (typeof value === "string" && CALENDAR_DATE.test(value)) return value;
  const d = parse(value);
  return d ? `${day(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : String(value);
}

/** 17:55:12: the time of day in this machine's time zone, for the lines of a log (fontego watch, fontego events). */
export function localTime(value: string | Date = new Date()): string {
  const d = parse(value);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : String(value);
}

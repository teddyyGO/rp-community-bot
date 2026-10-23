'use strict';

/**
 * Community-time helpers.
 *
 * The community's clock is a FIXED offset from UTC (UTC_OFFSET_HOURS, no DST).
 * A "day" for this bot runs DAY_START_HOUR -> DAY_START_HOUR local time (06:00
 * by default), NOT UTC midnight and NOT the host's timezone. All peak/daily
 * math keys off this boundary.
 *
 * Implementation note: we shift epoch milliseconds by the fixed offset and
 * read the UTC fields of a Date. Because the offset is fixed (no DST), this
 * is exact and never touches the host machine's local timezone.
 */

function envNum(name, dflt, min, max) {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(n) && n >= min && n <= max ? n : dflt;
}

const UTC_OFFSET_HOURS = envNum('UTC_OFFSET_HOURS', 0, -12, 14);
const OFFSET_MS = Math.round(UTC_OFFSET_HOURS * 60) * 60 * 1000;
const DAY_START_HOUR = Math.round(envNum('DAY_START_HOUR', 6, 0, 23)); // local day starts at 06:00
const DAY_MS = 24 * 60 * 60 * 1000;
// Postgres date math: `AT TIME ZONE INTERVAL '<n> minutes'` (ISO sign, east positive).
// Numeric only, so it is safe to interpolate into SQL.
const PG_OFFSET = `${Math.round(UTC_OFFSET_HOURS * 60)} minutes`;

function nowMs() {
  return Date.now();
}

/** Pad a number to 2 digits. */
function p2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Local "day key" (YYYY-MM-DD) that an instant belongs to, where the day
 * boundary is DAY_START_HOUR local (06:00 by default). Times between 00:00-05:59 local belong to the
 * previous calendar day.
 */
function localDayKey(ms = nowMs()) {
  const shifted = ms + OFFSET_MS - DAY_START_HOUR * 60 * 60 * 1000;
  const d = new Date(shifted);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/**
 * Epoch ms of the start (06:00 local) of the local day that `ms` is in.
 */
function localDayStart(ms = nowMs()) {
  const shifted = ms + OFFSET_MS - DAY_START_HOUR * 60 * 60 * 1000;
  const floored = Math.floor(shifted / DAY_MS) * DAY_MS;
  return floored - OFFSET_MS + DAY_START_HOUR * 60 * 60 * 1000;
}

/** Epoch ms of the start of the *next* local day after `ms`. */
function localDayEnd(ms = nowMs()) {
  return localDayStart(ms) + DAY_MS;
}

/**
 * The last `n` local day keys, oldest first, ending with the day `ms` is in.
 * e.g. n=7 -> 7 entries, [6 days ago ... today].
 */
function lastNDayKeys(n, ms = nowMs()) {
  const out = [];
  const start = localDayStart(ms);
  for (let i = n - 1; i >= 0; i--) {
    out.push(localDayKey(start - i * DAY_MS));
  }
  return out;
}

/** Human-friendly local wall-clock time, "HH:MM" (UTC_OFFSET_HOURS). */
function localTimeString(ms = nowMs()) {
  const d = new Date(ms + OFFSET_MS);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

/** Human-friendly local date+time, "YYYY-MM-DD HH:MM" (UTC_OFFSET_HOURS). */
function localDateTimeString(ms = nowMs()) {
  const d = new Date(ms + OFFSET_MS);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

/** Short weekday label (Mon..Sun) for a local day key 'YYYY-MM-DD'. */
function weekdayShort(dayKey) {
  // Treat the key as a local calendar date at noon to avoid edge rounding.
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getUTCDay()];
}

module.exports = {
  OFFSET_MS,
  DAY_START_HOUR,
  DAY_MS,
  UTC_OFFSET_HOURS,
  PG_OFFSET,
  nowMs,
  localDayKey,
  localDayStart,
  localDayEnd,
  lastNDayKeys,
  localTimeString,
  localDateTimeString,
  weekdayShort,
};

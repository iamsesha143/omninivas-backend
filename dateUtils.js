// Pure date-only helpers for the reminder system (Phase 1B). No I/O, no
// Supabase, no Express. Every function operates on / returns plain
// 'YYYY-MM-DD' strings or {year,month,day} objects -- NEVER on
// `new Date('YYYY-MM-DD')`'s local-time getters (.getDate()/.getMonth()/
// .getFullYear()), which read the *host machine's* timezone offset. Railway
// runs this process in UTC; reasoning about IST calendar dates through
// local-time getters would silently shift results near midnight IST.
//
// Calendar math (day numbering, leap years, month length) is done with an
// epoch-day algorithm (Howard Hinnant's days_from_civil / civil_from_days --
// a well-known, timezone-free proleptic-Gregorian conversion), not with
// Date object arithmetic at all, so nothing here can be affected by the
// host's timezone.

function parseISODate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Invalid ISO date: ${iso}`);
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`Invalid ISO date: ${iso}`);
  return { year, month, day };
}

function formatISODate({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

function daysInMonth(year, month) {
  const table = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[month - 1];
}

// days_from_civil (Hinnant) -- integer year/month/day -> a day count
// relative to a fixed epoch. Pure arithmetic, no Date object.
function toEpochDay({ year, month, day }) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// civil_from_days (Hinnant) -- the inverse of toEpochDay.
function fromEpochDay(z) {
  z += 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = month <= 2 ? y + 1 : y;
  return { year, month, day };
}

// Direct calendar-day arithmetic -- used for the day-based offset ladders
// (rent_due / rent_overdue), which are genuinely fixed day-counts.
function addDaysISO(iso, deltaDays) {
  return formatISODate(fromEpochDay(toEpochDay(parseISODate(iso)) + deltaDays));
}

// isoA - isoB, in whole days.
function diffDaysISO(isoA, isoB) {
  return toEpochDay(parseISODate(isoA)) - toEpochDay(parseISODate(isoB));
}

function compareISODates(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Calendar-month-safe shift, clamped to the target month's real last day
// (e.g. Mar 31 shifted -1 month -> Feb 28/29, never overflows into March).
// n > 0 shifts forward (e.g. agreement end = start shifted +agreement_months),
// n < 0 shifts backward (e.g. "2 months before" = event_date shifted -2).
function shiftMonthsISO(iso, n) {
  const { year, month, day } = parseISODate(iso);
  let targetMonth = month + n;
  let targetYear = year;
  while (targetMonth < 1) { targetMonth += 12; targetYear -= 1; }
  while (targetMonth > 12) { targetMonth -= 12; targetYear += 1; }
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return formatISODate({ year: targetYear, month: targetMonth, day: clampedDay });
}

// "N months before" event_date, clamped -- the month-based reminder ladder
// (warranty_expiry / agreement_renewal) uses this, then derives
// trigger_offset_days = diffDaysISO(result, event_date) for storage/display
// (see reminders.js) since the day-count varies month to month.
function monthsBeforeISO(iso, n) {
  return shiftMonthsISO(iso, -n);
}

// Recurring monthly due date for a given due_day, in the month that is
// `monthOffset` months from todayISO's month (0 = current month, -1/+1 =
// previous/next) -- clamped to that month's real last day, same convention
// obligations.due_day already uses elsewhere in this codebase (Math.min
// against the actual last day, not a hardcoded 28/30).
function dueDateForMonth(todayISO, monthOffset, dueDay) {
  const { year, month } = parseISODate(todayISO);
  let targetMonth = month + monthOffset;
  let targetYear = year;
  while (targetMonth < 1) { targetMonth += 12; targetYear -= 1; }
  while (targetMonth > 12) { targetMonth -= 12; targetYear += 1; }
  const clampedDay = Math.min(dueDay, daysInMonth(targetYear, targetMonth));
  return formatISODate({ year: targetYear, month: targetMonth, day: clampedDay });
}

// Given an explicit 'YYYY-MM' month and a recurring due_day, returns the due
// date for THAT exact month, clamped to its real last day. This is the one
// canonical due-date computation for an explicit month string -- both
// GET /api/properties/:propertyId/dues and GET /api/tenant/home now call
// this instead of each keeping their own inline clamp (the latter used to
// hardcode 28, silently wrong for due_day 29-31 in longer months; see the
// accompanying report for that fix).
function dueDateForExplicitMonth(monthStr, dueDay) {
  const m = /^(\d{4})-(\d{2})$/.exec(monthStr);
  if (!m) throw new Error(`Invalid month: ${monthStr}`);
  const year = Number(m[1]), month = Number(m[2]);
  const clampedDay = Math.min(dueDay, daysInMonth(year, month));
  return formatISODate({ year, month, day: clampedDay });
}

// The first-of-month 'YYYY-MM-01' form used by payments.period elsewhere in
// this codebase.
function periodForISO(iso) {
  const { year, month } = parseISODate(iso);
  return formatISODate({ year, month, day: 1 });
}

const REMINDER_TIMEZONE = 'Asia/Kolkata';

// The one place "now" enters this module. Uses Intl.DateTimeFormat with an
// explicit IANA timeZone -- NOT `new Date(...)`'s local-time getters, which
// would read the host machine's zone (UTC on Railway), not IST. 'en-CA'
// formats a short date as YYYY-MM-DD directly, so no further parsing of a
// locale-specific string is needed.
function todayISOInTimezone(timeZone = REMINDER_TIMEZONE, now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(now);
}

module.exports = {
  REMINDER_TIMEZONE,
  parseISODate, formatISODate, isLeapYear, daysInMonth,
  toEpochDay, fromEpochDay,
  addDaysISO, diffDaysISO, compareISODates,
  shiftMonthsISO, monthsBeforeISO, dueDateForMonth, dueDateForExplicitMonth, periodForISO,
  todayISOInTimezone
};

// Unit tests for dateUtils.js. Run with: node --test test/dateUtils.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const du = require('../dateUtils');

test('parseISODate / formatISODate round-trip', () => {
  assert.deepEqual(du.parseISODate('2026-08-08'), { year: 2026, month: 8, day: 8 });
  assert.equal(du.formatISODate({ year: 2026, month: 8, day: 8 }), '2026-08-08');
  assert.equal(du.formatISODate({ year: 2026, month: 1, day: 1 }), '2026-01-01');
});

test('parseISODate rejects malformed input', () => {
  assert.throws(() => du.parseISODate('2026-8-8'));
  assert.throws(() => du.parseISODate('not-a-date'));
  assert.throws(() => du.parseISODate('2026-13-01'));
});

test('isLeapYear / daysInMonth', () => {
  assert.equal(du.isLeapYear(2024), true);
  assert.equal(du.isLeapYear(2026), false);
  assert.equal(du.isLeapYear(2000), true);  // divisible by 400
  assert.equal(du.isLeapYear(1900), false); // divisible by 100, not 400
  assert.equal(du.daysInMonth(2024, 2), 29);
  assert.equal(du.daysInMonth(2026, 2), 28);
  assert.equal(du.daysInMonth(2026, 4), 30);
});

test('toEpochDay / fromEpochDay round-trip across many dates', () => {
  const samples = ['2026-01-01', '2026-12-31', '2024-02-29', '2000-01-01', '1999-12-31', '2026-08-08'];
  for (const iso of samples) {
    const parts = du.parseISODate(iso);
    assert.deepEqual(du.fromEpochDay(du.toEpochDay(parts)), parts, `round-trip failed for ${iso}`);
  }
});

test('addDaysISO: simple and month/year-crossing arithmetic', () => {
  assert.equal(du.addDaysISO('2026-08-08', 5), '2026-08-13');
  assert.equal(du.addDaysISO('2026-08-08', -10), '2026-07-29');
  assert.equal(du.addDaysISO('2026-12-30', 5), '2027-01-04');
  assert.equal(du.addDaysISO('2024-02-28', 1), '2024-02-29'); // leap year
  assert.equal(du.addDaysISO('2026-02-28', 1), '2026-03-01'); // non-leap year
});

test('diffDaysISO', () => {
  assert.equal(du.diffDaysISO('2026-08-13', '2026-08-08'), 5);
  assert.equal(du.diffDaysISO('2026-08-08', '2026-08-13'), -5);
  assert.equal(du.diffDaysISO('2026-08-08', '2026-08-08'), 0);
});

test('compareISODates', () => {
  assert.equal(du.compareISODates('2026-08-08', '2026-08-09'), -1);
  assert.equal(du.compareISODates('2026-08-09', '2026-08-08'), 1);
  assert.equal(du.compareISODates('2026-08-08', '2026-08-08'), 0);
});

// ---- Calendar-month-safe shifting: the exact scenario this module exists
// to get right (end-of-month clamping, never overflowing into the wrong
// month the way naive Date.setMonth() can).
test('shiftMonthsISO / monthsBeforeISO: end-of-month clamping', () => {
  assert.equal(du.shiftMonthsISO('2026-10-31', -2), '2026-08-31');
  assert.equal(du.monthsBeforeISO('2026-10-31', 2), '2026-08-31');
  // March 31 minus 1 month -> Feb has only 28 days in 2026 -> clamp to 28,
  // never overflow into March.
  assert.equal(du.monthsBeforeISO('2026-03-31', 1), '2026-02-28');
  // Same shift in a leap year -> clamp to 29.
  assert.equal(du.monthsBeforeISO('2024-03-31', 1), '2024-02-29');
});

test('shiftMonthsISO: forward shift (agreement end = start + N months), year rollover', () => {
  assert.equal(du.shiftMonthsISO('2026-01-31', 1), '2026-02-28');
  assert.equal(du.shiftMonthsISO('2026-10-15', 11), '2027-09-15'); // 11-month lease, crosses year boundary
  assert.equal(du.shiftMonthsISO('2026-01-01', 12), '2027-01-01');
});

test('dueDateForMonth: current/previous/next month, clamped to real last day', () => {
  assert.equal(du.dueDateForMonth('2026-08-15', 0, 28), '2026-08-28');
  assert.equal(du.dueDateForMonth('2026-08-15', -1, 28), '2026-07-28');
  assert.equal(du.dueDateForMonth('2026-08-15', 1, 28), '2026-09-28');
  // due_day=31 in a 30-day month clamps to that month's real last day.
  assert.equal(du.dueDateForMonth('2026-08-15', 0, 31), '2026-08-31');
  assert.equal(du.dueDateForMonth('2026-09-15', 0, 31), '2026-09-30');
  // due_day=29 in February of a non-leap year clamps to 28.
  assert.equal(du.dueDateForMonth('2026-02-10', 0, 29), '2026-02-28');
  assert.equal(du.dueDateForMonth('2024-02-10', 0, 29), '2024-02-29');
  // Year rollover at both ends.
  assert.equal(du.dueDateForMonth('2026-01-15', -1, 15), '2025-12-15');
  assert.equal(du.dueDateForMonth('2026-12-15', 1, 15), '2027-01-15');
});

// ---- dueDateForExplicitMonth: the one canonical due-date behavior, now
// shared by GET /api/properties/:propertyId/dues and GET /api/tenant/home
// (the latter previously hardcoded a 28-day clamp -- silently wrong for
// due_day 29-31 in any longer month; see the accompanying report). ----

test('dueDateForExplicitMonth: due_day within a 31-day month is not clamped', () => {
  assert.equal(du.dueDateForExplicitMonth('2026-08', 28), '2026-08-28');
  assert.equal(du.dueDateForExplicitMonth('2026-08', 31), '2026-08-31'); // August has 31 days
});

test('dueDateForExplicitMonth: due_day in a 30-day month clamps 31 down to 30', () => {
  assert.equal(du.dueDateForExplicitMonth('2026-09', 28), '2026-09-28');
  assert.equal(du.dueDateForExplicitMonth('2026-09', 30), '2026-09-30');
  assert.equal(du.dueDateForExplicitMonth('2026-09', 31), '2026-09-30'); // September has only 30
});

test('dueDateForExplicitMonth: February in a non-leap year clamps 29/30/31 down to 28', () => {
  assert.equal(du.dueDateForExplicitMonth('2026-02', 28), '2026-02-28');
  assert.equal(du.dueDateForExplicitMonth('2026-02', 29), '2026-02-28');
  assert.equal(du.dueDateForExplicitMonth('2026-02', 30), '2026-02-28');
  assert.equal(du.dueDateForExplicitMonth('2026-02', 31), '2026-02-28');
});

test('dueDateForExplicitMonth: February in a leap year clamps 30/31 down to 29, but allows 29 itself', () => {
  assert.equal(du.dueDateForExplicitMonth('2024-02', 28), '2024-02-28');
  assert.equal(du.dueDateForExplicitMonth('2024-02', 29), '2024-02-29'); // the real last day this year
  assert.equal(du.dueDateForExplicitMonth('2024-02', 30), '2024-02-29');
  assert.equal(du.dueDateForExplicitMonth('2024-02', 31), '2024-02-29');
});

test('dueDateForExplicitMonth: rejects a malformed month string', () => {
  assert.throws(() => du.dueDateForExplicitMonth('2026-8', 15));
  assert.throws(() => du.dueDateForExplicitMonth('not-a-month', 15));
});

test('periodForISO: first-of-month form matching payments.period elsewhere in this codebase', () => {
  assert.equal(du.periodForISO('2026-08-28'), '2026-08-01');
  assert.equal(du.periodForISO('2026-08-01'), '2026-08-01');
});

// ---- The core "no UTC/host-timezone shift" requirement ----
test('todayISOInTimezone: Asia/Kolkata date is correct even when host-UTC date differs', () => {
  // 2026-08-08T19:00:00Z = 2026-08-09T00:30:00+05:30 -- already the next
  // calendar day in IST while UTC still reads Aug 8. A host-local-getter
  // based implementation (new Date(...).getDate() etc, on a UTC host) would
  // wrongly return Aug 8 here.
  const lateUTC = new Date('2026-08-08T19:00:00.000Z');
  assert.equal(du.todayISOInTimezone('Asia/Kolkata', lateUTC), '2026-08-09');
  assert.equal(du.todayISOInTimezone('UTC', lateUTC), '2026-08-08');
});

test('todayISOInTimezone: IST date is correct just before local midnight rolls the UTC date', () => {
  // 2026-08-08T18:29:00Z = 2026-08-08T23:59:00+05:30 -- still Aug 8 in IST,
  // one minute before it becomes Aug 9 IST, while UTC already reads Aug 8
  // too here (this case mainly guards against an off-by-one in the offset).
  const justBeforeISTMidnight = new Date('2026-08-08T18:29:00.000Z');
  assert.equal(du.todayISOInTimezone('Asia/Kolkata', justBeforeISTMidnight), '2026-08-08');
});

test('todayISOInTimezone: early UTC morning is still the previous IST evening', () => {
  // 2026-08-09T02:00:00Z = 2026-08-09T07:30:00+05:30 -- both agree it's the
  // 9th here; pair with a case where UTC has already rolled but IST hasn't:
  // 2026-08-08T20:00:00Z = 2026-08-09T01:30:00+05:30 -- IST already the 9th.
  const utcAug8Night = new Date('2026-08-08T20:00:00.000Z');
  assert.equal(du.todayISOInTimezone('UTC', utcAug8Night), '2026-08-08');
  assert.equal(du.todayISOInTimezone('Asia/Kolkata', utcAug8Night), '2026-08-09');
});

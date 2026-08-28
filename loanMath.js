// Pure reducing-balance EMI math -- no I/O, mirrors the reminders.js /
// cashflow.js convention of keeping calculation logic separate from the
// routes that fetch/persist data. The owner enters the EMI they already
// pay (from their bank statement), so this module's job isn't to compute
// what the EMI *should* be -- it's to project the outstanding balance
// forward from the loan's own numbers, given how many months have elapsed.

function monthsElapsed(startDateISO, todayISO) {
  const [sy, sm] = startDateISO.split('-').map(Number);
  const [ty, tm] = todayISO.split('-').map(Number);
  const raw = (ty - sy) * 12 + (tm - sm);
  return Math.max(0, raw);
}

// Standard reducing-balance amortization: each month, interest accrues on
// the current balance, the rest of the EMI reduces principal. If the EMI is
// too small to even cover a month's interest, the balance would grow
// forever rather than amortize -- flagged explicitly (emiCoversInterest:
// false) rather than silently returning a misleading growing "outstanding"
// number, since that almost always means the entered EMI or rate is wrong,
// not a real loan behaving this way.
function projectOutstandingBalance({ principal, annualRatePercent, emiAmount, monthsElapsed: elapsed, tenureMonths }) {
  const monthlyRate = annualRatePercent / 100 / 12;
  const minViableEmi = principal * monthlyRate;
  if (emiAmount <= minViableEmi) {
    return { outstandingBalance: principal, monthsRemaining: null, emiCoversInterest: false };
  }

  const monthsToRun = Math.min(elapsed, tenureMonths);
  let balance = principal;
  for (let i = 0; i < monthsToRun; i++) {
    const interest = balance * monthlyRate;
    const principalComponent = emiAmount - interest;
    balance = Math.max(0, balance - principalComponent);
    if (balance <= 0) break;
  }

  const monthsRemaining = elapsed >= tenureMonths ? 0 : Math.max(0, tenureMonths - elapsed);
  return { outstandingBalance: Math.round(balance), monthsRemaining, emiCoversInterest: true };
}

module.exports = { monthsElapsed, projectOutstandingBalance };

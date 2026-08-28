// Extracted from GET /api/cashflow's local closure (2026-08-28) so the new
// CA export routes can reuse the identical settled-cash classification
// rules rather than a third copy of this logic. Byte-for-byte the same
// decision as before -- only the closure captures became explicit
// parameters; nothing about the classification itself changed.
function classifySettled({ rangeStart, rangeEnd, payments, maintenance, obligationsById, propertyName }) {
  const settledPayments = (payments || []).filter(p => p.status === 'paid' && paymentInRange(p, rangeStart, rangeEnd));
  const settledMaintenance = (maintenance || []).filter(m => m.status === 'paid' && m.paid_by === 'owner' && m.cost_date >= rangeStart && m.cost_date <= rangeEnd);
  let cashReceived = 0, expensesPaid = 0;
  const transactions = [];
  const categoryTotalsMap = new Map();
  const addCategory = (label, amount) => categoryTotalsMap.set(label, (categoryTotalsMap.get(label) || 0) + amount);
  for (const p of settledPayments) {
    const obligation = p.obligation_id ? obligationsById.get(p.obligation_id) : null;
    const isOwnerPaid = !!(obligation && obligation.paid_by === 'owner');
    const label = obligation ? obligation.label : 'Payment';
    const amt = Number(p.amount) || 0;
    if (isOwnerPaid) {
      expensesPaid += amt;
      addCategory(label, amt);
      transactions.push({ date: p.payment_date, amount: amt, direction: 'expense', label, property_name: propertyName(p.property_id), source: 'payment' });
    } else {
      cashReceived += amt;
      transactions.push({ date: p.payment_date, amount: amt, direction: 'income', label, property_name: propertyName(p.property_id), source: 'payment' });
    }
  }
  for (const m of settledMaintenance) {
    const amt = Number(m.amount) || 0;
    expensesPaid += amt;
    addCategory('Maintenance', amt);
    transactions.push({ date: m.cost_date, amount: amt, direction: 'expense', label: m.description || (m.vendor_name ? `Maintenance — ${m.vendor_name}` : 'Maintenance'), property_name: propertyName(m.property_id), source: 'maintenance' });
  }
  transactions.sort((a, b) => (a.date < b.date ? 1 : -1));
  const categoryTotals = [...categoryTotalsMap.entries()].map(([label, amount]) => ({ label, amount })).sort((a, b) => b.amount - a.amount);
  return { cashReceived, expensesPaid, netCashFlow: cashReceived - expensesPaid, transactions, categoryTotals };
}

// A payment's `period` should always be set (YYYY-MM-01), but the WhatsApp
// "record as a payment" apply flow historically didn't send it, leaving
// period NULL on some already-settled rows -- fall back to payment_date
// rather than silently dropping those from any total.
function paymentInRange(payment, rangeStart, rangeEnd) {
  const d = payment.period || payment.payment_date;
  return d >= rangeStart && d <= rangeEnd;
}

// Extracted from GET /api/cashflow's local block (2026-08-28), same reason
// as classifySettled above -- the CA export needs the identical deposits
// list, byte-for-byte the same shape.
function computeDeposits({ tenants, propertyName }) {
  return (tenants || [])
    .filter(t => t.deposit_amount)
    .map(t => {
      const agreed = Number(t.deposit_amount) || 0;
      const refunded = Number(t.deposit_refunded_amount) || 0;
      let status = 'awaiting_confirmation';
      if (t.deposit_paid_date) status = refunded > 0 ? (refunded >= agreed ? 'refunded' : 'partially_refunded') : 'received';
      return {
        tenant_id: t.id, tenant_name: t.name, property_name: propertyName(t.property_id),
        agreed_amount: agreed, received_date: t.deposit_paid_date || null, received_details: t.deposit_details || null,
        refunded_amount: t.deposit_refunded_amount || null, refunded_date: t.deposit_refunded_date || null, status
      };
    });
}

// Arithmetic-only flag, never advice (per this project's own working
// agreement: "Never phrase Phase 5 financial output as advice"). Section
// 194-IB requires an individual/HUF tenant to deduct 5% TDS when MONTHLY
// rent exceeds ₹50,000 -- checked against the agreed obligation amount, not
// payment history, since the law's threshold is about the rent rate itself,
// not whether it was actually paid on time or in full.
const TDS_194IB_MONTHLY_THRESHOLD = 50000;
function tdsFlags({ obligations, propertyName }) {
  return (obligations || [])
    .filter(o => o.type === 'rent' && o.paid_by === 'tenant' && Number(o.amount) > TDS_194IB_MONTHLY_THRESHOLD)
    .map(o => ({
      property_name: propertyName(o.property_id), monthly_rent: Number(o.amount),
      note: 'Monthly rent exceeds ₹50,000 -- TDS may apply under Section 194-IB. Verify with your CA.'
    }));
}

// India's financial year: April 1 through March 31. `startYear` is the
// calendar year the FY begins in (FY 2026-27 -> startYear 2026, runs
// 2026-04-01 through 2027-03-31) -- the convention Indian CAs use.
function fiscalYearRange(startYear) {
  const y = Number(startYear);
  return { start: `${y}-04-01`, end: `${y + 1}-03-31`, label: `FY ${y}-${String(y + 1).slice(2)}` };
}

// The FY currently in progress, based on today's date -- Jan-Mar falls in
// the FY that STARTED the previous calendar year.
function currentFiscalYearStart(todayISO) {
  const [year, month] = todayISO.split('-').map(Number);
  return month >= 4 ? year : year - 1;
}

module.exports = { classifySettled, paymentInRange, computeDeposits, tdsFlags, fiscalYearRange, currentFiscalYearStart };

// core/financial-calc.js — Deterministic financial calculators for the CFO agent
// Aeldorado by Solanacy Technologies
//
// WHY THIS EXISTS:
// LLMs are unreliable at multi-step arithmetic, especially compounding
// calculations (e.g. monthly churn compounding over a year). Testing showed
// the CFO agent producing numbers off by ~8x on a churn-loss calculation
// when left to compute in free text. Rather than trust the model's mental
// math, these functions compute the actual number in code, and the agent's
// job is only to explain/contextualize a value that is already correct.
//
// Each function returns both the final number AND a step-by-step trace,
// so the agent can "show its math" using real intermediate values instead
// of inventing plausible-looking-but-wrong ones.

/**
 * Estimate revenue lost to churn over a period, compounding monthly.
 *
 * @param {number} customers - starting customer count
 * @param {number} pricePerCustomer - revenue per customer per period (e.g. per month)
 * @param {number} churnRate - monthly churn rate as a decimal (e.g. 0.05 for 5%)
 * @param {number} months - number of months to project (default 12)
 * @param {number} newCustomersPerMonth - optional new customer acquisitions per month (default 0)
 * @returns {{ totalRevenueLoss: number, endingCustomers: number, monthlyTrace: Array }}
 */
export function calculateChurnLoss({
  customers,
  pricePerCustomer,
  churnRate,
  months = 12,
  newCustomersPerMonth = 0,
}) {
  if (customers < 0 || pricePerCustomer < 0 || churnRate < 0 || churnRate > 1 || months < 1) {
    throw new Error("Invalid input to calculateChurnLoss: check ranges (churnRate must be 0-1).");
  }

  let remaining = customers;
  let totalRevenueLoss = 0;
  const monthlyTrace = [];

  for (let month = 1; month <= months; month++) {
    const lostCustomers = remaining * churnRate;
    const revenueLostThisMonth = lostCustomers * pricePerCustomer;
    totalRevenueLoss += revenueLostThisMonth;
    remaining = remaining - lostCustomers + newCustomersPerMonth;

    monthlyTrace.push({
      month,
      customersAtStart: Number(remaining.toFixed(2)),
      customersLost: Number(lostCustomers.toFixed(2)),
      revenueLostThisMonth: Number(revenueLostThisMonth.toFixed(2)),
    });
  }

  return {
    totalRevenueLoss: Number(totalRevenueLoss.toFixed(2)),
    endingCustomers: Number(remaining.toFixed(2)),
    monthlyTrace,
  };
}

/**
 * Compute LTV:CAC ratio and payback period.
 *
 * @param {number} arpu - average revenue per user per period (e.g. per month)
 * @param {number} grossMarginPct - gross margin as a decimal (e.g. 0.8 for 80%)
 * @param {number} churnRate - period churn rate as a decimal
 * @param {number} cac - customer acquisition cost
 * @returns {{ ltv: number, ltvToCacRatio: number, paybackMonths: number }}
 */
export function calculateLtvCac({ arpu, grossMarginPct, churnRate, cac }) {
  if (churnRate <= 0) {
    throw new Error("churnRate must be > 0 to compute LTV (division by zero).");
  }
  const avgCustomerLifespanMonths = 1 / churnRate;
  const ltv = arpu * grossMarginPct * avgCustomerLifespanMonths;
  const ltvToCacRatio = cac > 0 ? ltv / cac : null;
  const paybackMonths = arpu * grossMarginPct > 0 ? cac / (arpu * grossMarginPct) : null;

  return {
    ltv: Number(ltv.toFixed(2)),
    ltvToCacRatio: ltvToCacRatio !== null ? Number(ltvToCacRatio.toFixed(2)) : null,
    paybackMonths: paybackMonths !== null ? Number(paybackMonths.toFixed(2)) : null,
    avgCustomerLifespanMonths: Number(avgCustomerLifespanMonths.toFixed(2)),
  };
}

/**
 * Simple compound growth projection (e.g. MRR growing at X%/month).
 *
 * @param {number} startingValue
 * @param {number} growthRatePct - as a decimal (e.g. 0.1 for 10%/month)
 * @param {number} periods
 * @returns {{ endingValue: number, trace: Array }}
 */
export function calculateCompoundGrowth({ startingValue, growthRatePct, periods }) {
  let value = startingValue;
  const trace = [];
  for (let i = 1; i <= periods; i++) {
    value = value * (1 + growthRatePct);
    trace.push({ period: i, value: Number(value.toFixed(2)) });
  }
  return { endingValue: Number(value.toFixed(2)), trace };
}

/**
 * Basic margin calculation.
 *
 * @param {number} price
 * @param {number} costOfGoodsSold
 * @returns {{ grossProfit: number, grossMarginPct: number }}
 */
export function calculateMargin({ price, costOfGoodsSold }) {
  const grossProfit = price - costOfGoodsSold;
  const grossMarginPct = price > 0 ? (grossProfit / price) * 100 : null;
  return {
    grossProfit: Number(grossProfit.toFixed(2)),
    grossMarginPct: grossMarginPct !== null ? Number(grossMarginPct.toFixed(2)) : null,
  };
}

/**
 * Burn rate and runway.
 *
 * @param {number} cashBalance - current cash on hand
 * @param {number} monthlyRevenue - average monthly revenue (0 if pre-revenue)
 * @param {number} monthlyExpenses - average monthly total expenses
 * @returns {{ netBurn: number, isProfitable: boolean, runwayMonths: number|null }}
 */
export function calculateBurnRateRunway({ cashBalance, monthlyRevenue, monthlyExpenses }) {
  if (cashBalance < 0 || monthlyRevenue < 0 || monthlyExpenses < 0) {
    throw new Error("Invalid input to calculateBurnRateRunway: values must be non-negative.");
  }
  const netBurn = monthlyExpenses - monthlyRevenue;
  const isProfitable = netBurn <= 0;
  const runwayMonths = isProfitable ? null : Number((cashBalance / netBurn).toFixed(2));

  return {
    netBurn: Number(netBurn.toFixed(2)),
    isProfitable,
    runwayMonths,
  };
}

/**
 * Break-even point in units and revenue, from standard fixed/variable cost model.
 *
 * @param {number} fixedCosts - total fixed costs for the period
 * @param {number} pricePerUnit - selling price per unit
 * @param {number} variableCostPerUnit - variable cost per unit
 * @returns {{ breakEvenUnits: number, breakEvenRevenue: number, contributionMarginPerUnit: number }}
 */
export function calculateBreakEven({ fixedCosts, pricePerUnit, variableCostPerUnit }) {
  if (fixedCosts < 0 || pricePerUnit <= 0 || variableCostPerUnit < 0) {
    throw new Error("Invalid input to calculateBreakEven: pricePerUnit must be > 0, others >= 0.");
  }
  const contributionMarginPerUnit = pricePerUnit - variableCostPerUnit;
  if (contributionMarginPerUnit <= 0) {
    throw new Error("Invalid input to calculateBreakEven: pricePerUnit must exceed variableCostPerUnit (positive contribution margin required).");
  }
  const breakEvenUnits = fixedCosts / contributionMarginPerUnit;
  const breakEvenRevenue = breakEvenUnits * pricePerUnit;

  return {
    breakEvenUnits: Number(breakEvenUnits.toFixed(2)),
    breakEvenRevenue: Number(breakEvenRevenue.toFixed(2)),
    contributionMarginPerUnit: Number(contributionMarginPerUnit.toFixed(2)),
  };
}

/**
 * Month-over-month growth rate and simple ARR from a current MRR figure.
 *
 * @param {number} currentMRR
 * @param {number} previousMRR
 * @returns {{ momGrowthPct: number|null, arr: number }}
 */
export function calculateMrrGrowth({ currentMRR, previousMRR }) {
  if (currentMRR < 0 || previousMRR < 0) {
    throw new Error("Invalid input to calculateMrrGrowth: values must be non-negative.");
  }
  const momGrowthPct = previousMRR > 0
    ? Number((((currentMRR - previousMRR) / previousMRR) * 100).toFixed(2))
    : null; // undefined growth rate from a zero base — don't guess
  const arr = Number((currentMRR * 12).toFixed(2));

  return { momGrowthPct, arr };
}

/**
 * "Rule of 40" — a standard SaaS efficiency benchmark: growth rate % + profit
 * margin % should be >= 40 for a healthy business. Widely used by investors,
 * so this is a common ask, not a company-specific metric.
 *
 * @param {number} revenueGrowthPct - YoY or annualized revenue growth, as a percentage (e.g. 30 for 30%)
 * @param {number} profitMarginPct - profit margin as a percentage (can be negative)
 * @returns {{ ruleOf40Score: number, passes: boolean }}
 */
export function calculateRuleOf40({ revenueGrowthPct, profitMarginPct }) {
  const ruleOf40Score = Number((revenueGrowthPct + profitMarginPct).toFixed(2));
  return {
    ruleOf40Score,
    passes: ruleOf40Score >= 40,
  };
}

/**
 * Simple liquidity check — current ratio (also usable as a quick proxy for
 * quick ratio if inventory is passed as 0 or excluded from currentAssets).
 *
 * @param {number} currentAssets
 * @param {number} currentLiabilities
 * @returns {{ currentRatio: number|null, isHealthy: boolean|null }}
 */
export function calculateCurrentRatio({ currentAssets, currentLiabilities }) {
  if (currentAssets < 0 || currentLiabilities < 0) {
    throw new Error("Invalid input to calculateCurrentRatio: values must be non-negative.");
  }
  if (currentLiabilities === 0) {
    return { currentRatio: null, isHealthy: null };
  }
  const currentRatio = Number((currentAssets / currentLiabilities).toFixed(2));
  return {
    currentRatio,
    isHealthy: currentRatio >= 1.5, // standard rule-of-thumb threshold, generically applicable
  };
}

/**
 * Simple revenue-multiple valuation estimate. Purely mechanical — the
 * multiple itself is a user/market-supplied assumption, not invented here.
 *
 * @param {number} arr - annual recurring revenue
 * @param {number} multiple - revenue multiple to apply (user-supplied or market-typical, e.g. 5-10x for SaaS)
 * @returns {{ estimatedValuation: number }}
 */
export function calculateRevenueMultipleValuation({ arr, multiple }) {
  if (arr < 0 || multiple <= 0) {
    throw new Error("Invalid input to calculateRevenueMultipleValuation: arr must be >= 0, multiple must be > 0.");
  }
  return { estimatedValuation: Number((arr * multiple).toFixed(2)) };
}

/**
 * Registry describing each calculator for LLM tool-calling / detection.
 * Used by cfo.js to decide when a query should be routed through code
 * instead of left to the model's free-text reasoning.
 */
export const FINANCIAL_CALCULATORS = {
  churn_loss: {
    fn: calculateChurnLoss,
    triggerKeywords: ["churn", "revenue loss", "attrition"],
    requiredParams: ["customers", "pricePerCustomer", "churnRate"],
  },
  ltv_cac: {
    fn: calculateLtvCac,
    triggerKeywords: ["ltv", "cac", "lifetime value", "payback period"],
    requiredParams: ["arpu", "grossMarginPct", "churnRate", "cac"],
  },
  compound_growth: {
    fn: calculateCompoundGrowth,
    triggerKeywords: ["compound growth", "projected mrr", "growth rate"],
    requiredParams: ["startingValue", "growthRatePct", "periods"],
  },
  margin: {
    fn: calculateMargin,
    triggerKeywords: ["margin", "gross profit", "markup"],
    requiredParams: ["price", "costOfGoodsSold"],
  },
  burn_rate_runway: {
    fn: calculateBurnRateRunway,
    triggerKeywords: ["burn rate", "runway", "months of cash", "cash left"],
    requiredParams: ["cashBalance", "monthlyRevenue", "monthlyExpenses"],
  },
  break_even: {
    fn: calculateBreakEven,
    triggerKeywords: ["break even", "break-even", "breakeven"],
    requiredParams: ["fixedCosts", "pricePerUnit", "variableCostPerUnit"],
  },
  mrr_growth: {
    fn: calculateMrrGrowth,
    triggerKeywords: ["mom growth", "month over month", "mrr growth", "arr from mrr"],
    requiredParams: ["currentMRR", "previousMRR"],
  },
  rule_of_40: {
    fn: calculateRuleOf40,
    triggerKeywords: ["rule of 40", "rule of forty"],
    requiredParams: ["revenueGrowthPct", "profitMarginPct"],
  },
  current_ratio: {
    fn: calculateCurrentRatio,
    triggerKeywords: ["current ratio", "quick ratio", "liquidity"],
    requiredParams: ["currentAssets", "currentLiabilities"],
  },
  revenue_multiple_valuation: {
    fn: calculateRevenueMultipleValuation,
    triggerKeywords: ["valuation", "revenue multiple", "company worth"],
    requiredParams: ["arr", "multiple"],
  },
};

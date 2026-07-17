// core/sales-calc.js — Deterministic calculators for the Sales agent
// Aeldorado by Solanacy Technologies
//
// WHY THIS EXISTS:
// The Sales agent was pure text generation — deal_analyzer "estimated win/loss
// probability" by having the model guess from vibes, with no scoring formula
// behind it. Same failure mode financial-calc.js fixed for CFO (LLMs are
// unreliable at anything resembling arithmetic or consistent scoring), just
// showing up here as an invented-looking probability instead of a wrong sum.
//
// These functions compute the actual score/number in code from a declared,
// inspectable weighting model. The agent's job is only to explain/strategize
// around a number that is already correct and reproducible — same input
// always produces the same output, unlike free-text "probability" guesses.
//
// NOTE ON WEIGHTS: unlike financial-calc.js (break-even, burn rate — settled
// accounting formulas), the weights in calculateDealScore are a defensible
// BANT/MEDDIC-informed default, not a law of physics. They're declared as a
// named constant below so they're visible and tunable, not buried in prose.
// The determinism guarantee is "same inputs -> same score, always" — not
// "this is the one true weighting scheme."

/**
 * Default weighting model for deal scoring, out of 100 total points.
 * Based on common BANT (Budget, Authority, Need, Timeline) + engagement
 * signal factors used in standard lead/deal scoring frameworks.
 *
 * CALIBRATION: these are sensible starting defaults, not a fixed law. Once
 * enough closed-won/closed-lost history exists, re-derive these by checking
 * which factors actually correlated with wins (e.g. logistic regression
 * coefficients on historical deals, normalized to sum to 100) and update
 * this object — every caller picks the change up automatically since
 * nothing else hardcodes these numbers.
 */
// [PROPRIETARY — REDACTED] Exact calibrated weight values removed from this
// public copy. Structure preserved: 5 BANT+engagement factors, weights sum
// to 100, validated by validateWeights() below. See file header for the
// calibration methodology (re-derivable from closed-won/lost history).
export const DEAL_SCORE_WEIGHTS = {
  budgetConfirmed: 0,      // [REDACTED]
  authorityLevel: 0,       // [REDACTED]
  needUrgency: 0,          // [REDACTED]
  timelineFit: 0,          // [REDACTED]
  engagementSignals: 0,    // [REDACTED]
};

function validateWeights(weights) {
  const keys = ["budgetConfirmed", "authorityLevel", "needUrgency", "timelineFit", "engagementSignals"];
  for (const k of keys) {
    if (typeof weights[k] !== "number" || weights[k] < 0) {
      throw new Error(`Invalid weight "${k}": must be a non-negative number.`);
    }
  }
  const total = keys.reduce((sum, k) => sum + weights[k], 0);
  if (Math.abs(total - 100) > 0.01) {
    throw new Error(`Deal score weights must sum to 100 (got ${total}). Adjust DEAL_SCORE_WEIGHTS or the custom weights passed in.`);
  }
}

/**
 * Score a deal against a weighted BANT-style model.
 *
 * Each input factor is a 0-1 scale (e.g. 0 = no budget confirmed, 1 = budget
 * fully confirmed and allocated) representing how strongly that factor is
 * present. The function does the weighting arithmetic — the model's job is
 * only to judge each factor from context, not to invent a final score.
 *
 * Optionally pass `confidence` per factor (0-1, how certain/well-evidenced
 * that factor's estimate is — e.g. "budget mentioned once in passing" is
 * low confidence, "signed budget approval email quoted" is high confidence).
 * If omitted, a factor defaults to confidence 1 (fully trusted). The overall
 * `dataConfidence` returned is the average confidence across factors, so a
 * score built on thin/ambiguous signals visibly reports itself as less
 * reliable instead of presenting a guess as equally certain as hard fact.
 *
 * @param {number} budgetConfirmed - 0-1, how confirmed/available budget is
 * @param {number} authorityLevel - 0-1, how much decision-making authority is engaged
 * @param {number} needUrgency - 0-1, how urgent/painful the need is
 * @param {number} timelineFit - 0-1, how well the buying timeline aligns with a realistic close
 * @param {number} engagementSignals - 0-1, responsiveness/engagement strength
 * @param {Object} [confidence] - optional 0-1 confidence per factor, same keys as above
 * @param {Object} [weights] - optional custom weights (must sum to 100); defaults to DEAL_SCORE_WEIGHTS
 * @returns {{ score: number, breakdown: Object, riskFactors: string[], tier: string, dataConfidence: number, confidenceLabel: string }}
 */
export function calculateDealScore({
  budgetConfirmed,
  authorityLevel,
  needUrgency,
  timelineFit,
  engagementSignals,
  confidence = {},
  weights = DEAL_SCORE_WEIGHTS,
}) {
  const factors = { budgetConfirmed, authorityLevel, needUrgency, timelineFit, engagementSignals };
  for (const [key, val] of Object.entries(factors)) {
    if (val === undefined || val === null || val < 0 || val > 1) {
      throw new Error(`Invalid input to calculateDealScore: ${key} must be a number between 0 and 1.`);
    }
  }
  validateWeights(weights);

  const breakdown = {
    budgetConfirmed: Number((budgetConfirmed * weights.budgetConfirmed).toFixed(2)),
    authorityLevel: Number((authorityLevel * weights.authorityLevel).toFixed(2)),
    needUrgency: Number((needUrgency * weights.needUrgency).toFixed(2)),
    timelineFit: Number((timelineFit * weights.timelineFit).toFixed(2)),
    engagementSignals: Number((engagementSignals * weights.engagementSignals).toFixed(2)),
  };

  const score = Number(
    Object.values(breakdown).reduce((sum, v) => sum + v, 0).toFixed(2)
  );

  // Flag weak factors (below 40% of their own max) as concrete risk factors,
  // rather than the model inventing generic-sounding risks.
  const riskFactors = [];
  if (budgetConfirmed < 0.4) riskFactors.push("Budget not confirmed — financial commitment unclear.");
  if (authorityLevel < 0.4) riskFactors.push("Low decision-maker engagement — may be talking to non-buyers.");
  if (needUrgency < 0.4) riskFactors.push("Low urgency — pain point may not be pressing enough to drive a decision.");
  if (timelineFit < 0.4) riskFactors.push("Timeline misaligned — no clear buying window.");
  if (engagementSignals < 0.4) riskFactors.push("Weak engagement — low responsiveness or single-stakeholder contact.");

  let tier;
  if (score >= 75) tier = "hot";
  else if (score >= 50) tier = "warm";
  else if (score >= 25) tier = "cool";
  else tier = "cold";

  // Data confidence: average of per-factor confidence (defaulting missing
  // ones to 1, i.e. "trust the estimate fully" if the caller didn't flag it
  // as uncertain). This is separate from the score itself — a score can be
  // high (hot deal) but low-confidence (based on thin/inferred signals), and
  // that distinction should stay visible rather than collapsing into one
  // number that overstates certainty.
  const confKeys = ["budgetConfirmed", "authorityLevel", "needUrgency", "timelineFit", "engagementSignals"];
  const confValues = confKeys.map((k) => {
    const c = confidence[k];
    return (typeof c === "number" && c >= 0 && c <= 1) ? c : 1;
  });
  const dataConfidence = Number(
    (confValues.reduce((sum, v) => sum + v, 0) / confValues.length).toFixed(2)
  );

  let confidenceLabel;
  if (dataConfidence >= 0.8) confidenceLabel = "high";
  else if (dataConfidence >= 0.5) confidenceLabel = "medium";
  else confidenceLabel = "low";

  return { score, breakdown, riskFactors, tier, dataConfidence, confidenceLabel };
}

/**
 * Weighted pipeline forecast — pipeline value x stage-weighted probability,
 * summed across all deals. Standard sales forecasting method.
 *
 * @param {Array<{value: number, stageProbability: number, name?: string}>} deals
 *   - value: deal value in currency units
 *   - stageProbability: 0-1, probability of closing from current stage
 * @returns {{ totalPipelineValue: number, weightedForecast: number, dealBreakdown: Array }}
 */
export function calculateWeightedForecast({ deals }) {
  if (!Array.isArray(deals) || deals.length === 0) {
    throw new Error("Invalid input to calculateWeightedForecast: deals must be a non-empty array.");
  }

  let totalPipelineValue = 0;
  let weightedForecast = 0;
  const dealBreakdown = [];

  for (const deal of deals) {
    const { value, stageProbability, name } = deal;
    if (value < 0 || stageProbability < 0 || stageProbability > 1) {
      throw new Error("Invalid deal in calculateWeightedForecast: value must be >= 0, stageProbability must be 0-1.");
    }
    const weightedValue = value * stageProbability;
    totalPipelineValue += value;
    weightedForecast += weightedValue;
    dealBreakdown.push({
      name: name || "Unnamed deal",
      value: Number(value.toFixed(2)),
      stageProbability,
      weightedValue: Number(weightedValue.toFixed(2)),
    });
  }

  return {
    totalPipelineValue: Number(totalPipelineValue.toFixed(2)),
    weightedForecast: Number(weightedForecast.toFixed(2)),
    dealBreakdown,
  };
}

/**
 * Quota attainment — closed revenue + weighted pipeline vs a quota target.
 *
 * @param {number} closedRevenue - revenue already closed/won this period
 * @param {number} weightedPipelineValue - stage-weighted value of remaining open pipeline (use calculateWeightedForecast first)
 * @param {number} quotaTarget - the quota target for the period
 * @returns {{ attainmentPct: number, projectedAttainmentPct: number, gapToTarget: number, onTrack: boolean }}
 */
export function calculateQuotaAttainment({ closedRevenue, weightedPipelineValue, quotaTarget }) {
  if (closedRevenue < 0 || weightedPipelineValue < 0 || quotaTarget <= 0) {
    throw new Error("Invalid input to calculateQuotaAttainment: quotaTarget must be > 0, others >= 0.");
  }

  const attainmentPct = Number(((closedRevenue / quotaTarget) * 100).toFixed(2));
  const projectedTotal = closedRevenue + weightedPipelineValue;
  const projectedAttainmentPct = Number(((projectedTotal / quotaTarget) * 100).toFixed(2));
  const gapToTarget = Number((quotaTarget - projectedTotal).toFixed(2));

  return {
    attainmentPct,
    projectedAttainmentPct,
    gapToTarget: gapToTarget > 0 ? gapToTarget : 0,
    onTrack: projectedAttainmentPct >= 100,
  };
}

/**
 * Standard SaaS sales velocity formula:
 * (# of qualified opportunities x win rate x avg deal size) / sales cycle length (days)
 * = revenue generated per day, on average, by the sales process.
 *
 * @param {number} opportunities - number of qualified open opportunities
 * @param {number} winRate - as a decimal (e.g. 0.25 for 25%)
 * @param {number} avgDealSize - average deal value
 * @param {number} salesCycleDays - average sales cycle length in days
 * @returns {{ salesVelocity: number, dailyRevenueRate: number }}
 */
export function calculateSalesVelocity({ opportunities, winRate, avgDealSize, salesCycleDays }) {
  if (opportunities < 0 || winRate < 0 || winRate > 1 || avgDealSize < 0 || salesCycleDays <= 0) {
    throw new Error("Invalid input to calculateSalesVelocity: salesCycleDays must be > 0, winRate must be 0-1, others >= 0.");
  }

  const salesVelocity = Number(
    ((opportunities * winRate * avgDealSize) / salesCycleDays).toFixed(2)
  );

  return {
    salesVelocity,           // revenue per day
    dailyRevenueRate: salesVelocity,
  };
}

/**
 * Registry describing each calculator for LLM tool-calling / detection.
 * Used by sales.js to decide when a query should be routed through code
 * instead of left to the model's free-text reasoning.
 */
export const SALES_CALCULATORS = {
  deal_score: {
    fn: calculateDealScore,
    triggerKeywords: ["deal score", "win probability", "lead score", "qualify this deal", "how likely to close"],
    requiredParams: ["budgetConfirmed", "authorityLevel", "needUrgency", "timelineFit", "engagementSignals"],
  },
  weighted_forecast: {
    fn: calculateWeightedForecast,
    triggerKeywords: ["forecast", "pipeline value", "weighted pipeline", "projected revenue"],
    requiredParams: ["deals"],
  },
  quota_attainment: {
    fn: calculateQuotaAttainment,
    triggerKeywords: ["quota attainment", "hit quota", "quota gap", "on track for quota"],
    requiredParams: ["closedRevenue", "weightedPipelineValue", "quotaTarget"],
  },
  sales_velocity: {
    fn: calculateSalesVelocity,
    triggerKeywords: ["sales velocity", "revenue per day", "velocity formula"],
    requiredParams: ["opportunities", "winRate", "avgDealSize", "salesCycleDays"],
  },
};

/**
 * Structured objection-handling knowledge base. Instead of the model
 * inventing an objection response strategy from scratch each time (variable
 * quality, no consistency across calls), common objection categories map to
 * a proven counter-framework. The model still personalizes the wording for
 * the specific deal context — the strategy/structure is grounded, not the
 * verbatim text.
 */
// [PROPRIETARY — REDACTED] The full counter-strategy text for each objection
// category has been removed from this public copy. Trigger-keyword signals
// kept (non-sensitive) to show the matching approach; the actual "framework"
// strategy text (the sales-methodology IP) is stubbed out below. In
// production there are 6 categories: price/budget, authority, timing,
// trust/risk-aversion, competitor comparison, and status-quo/no-perceived-need.
export const OBJECTION_FRAMEWORKS = {
  price: {
    category: "Price / Budget",
    signals: ["too expensive", "no budget", "can't afford", "cheaper elsewhere", "price is high"],
    framework: "[REDACTED — proprietary counter-strategy not included in public showcase]",
  },
  authority: {
    category: "Authority / Need to Check with Someone",
    signals: ["need to check with my boss", "not my decision", "have to run this by"],
    framework: "[REDACTED — proprietary counter-strategy not included in public showcase]",
  },
  timing: {
    category: "Timing / Not Right Now",
    signals: ["not right now", "maybe next quarter", "too busy", "revisit later"],
    framework: "[REDACTED — proprietary counter-strategy not included in public showcase]",
  },
  trust: {
    category: "Trust / Risk Aversion",
    signals: ["never heard of you", "how do I know this works", "what if it doesn't work", "risky"],
    framework: "[REDACTED — proprietary counter-strategy not included in public showcase]",
  },
  competitor: {
    category: "Competitor Comparison",
    signals: ["already using a competitor", "comparing you to", "why not just use"],
    framework: "[REDACTED — proprietary counter-strategy not included in public showcase]",
  },
  status_quo: {
    category: "Status Quo / No Perceived Need",
    signals: ["we're fine with what we have", "not a priority", "don't see the need"],
    framework: "[REDACTED — proprietary counter-strategy not included in public showcase]",
  },
};

/**
 * Match free-text objection language to the closest known framework category
 * by simple keyword overlap. Deterministic (no LLM call) — the LLM only
 * personalizes wording after this returns the grounded strategy to use.
 *
 * @param {string} objectionText - the raw objection as stated by the prospect
 * @returns {{ matched: boolean, category?: string, framework?: string, key?: string }}
 */
export function matchObjectionFramework(objectionText) {
  if (!objectionText || typeof objectionText !== "string") {
    return { matched: false };
  }
  const lower = objectionText.toLowerCase();

  for (const [key, entry] of Object.entries(OBJECTION_FRAMEWORKS)) {
    if (entry.signals.some((signal) => lower.includes(signal))) {
      return { matched: true, key, category: entry.category, framework: entry.framework };
    }
  }
  return { matched: false };
}

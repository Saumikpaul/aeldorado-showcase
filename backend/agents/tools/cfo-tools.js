// agents/tools/cfo-tools.js — Structured tool definitions for the CFO agent
// Aeldorado by Solanacy Technologies
//
// Each entry builds a sharply-scoped task string for the existing
// runCFOAgent() runner — no new agent logic, just structured prompts.
// Registered lazily via the tool-registry (see tool-registry.js).

import { z } from "zod";

export const CFO_TOOLS = {
  financial_health_checker: {
    agent: "cfo",
    description:
      "Analyze revenue, expenses, and burn rate to produce a full financial health check with recommendations.",
    inputSchema: {
      revenue: z.string().describe("Revenue figures or summary (e.g. '₹5L/month MRR')"),
      expenses: z.string().describe("Expense breakdown or summary"),
      burn_rate: z.string().optional().describe("Monthly burn rate, if known"),
    },
    buildTask: ({ revenue, expenses, burn_rate }) =>
      `Perform a full financial health check.\n\n` +
      `Revenue: ${revenue}\n` +
      `Expenses: ${expenses}\n` +
      `Burn rate: ${burn_rate || "not provided — estimate qualitatively if possible, otherwise state data not available"}\n\n` +
      `Provide: detailed financial analysis, key concerns, and concrete recommendations.`,
  },

  pricing_strategy_tool: {
    agent: "cfo",
    description:
      "Given product info and market context, generate an optimal pricing strategy.",
    inputSchema: {
      product_info: z.string().describe("Product description, cost structure, or current pricing"),
      market_context: z.string().describe("Target market, competitors, or positioning context"),
    },
    buildTask: ({ product_info, market_context }) =>
      `Design an optimal pricing strategy.\n\n` +
      `Product info: ${product_info}\n` +
      `Market context: ${market_context}\n\n` +
      `Provide: recommended pricing model/tiers, rationale, and risks to watch.`,
  },

  invoice_generator: {
    agent: "cfo",
    description:
      "Generate professional invoice content from client info and line items.",
    inputSchema: {
      client_info: z.string().describe("Client name, address, contact details"),
      items: z.string().describe("Line items / services rendered with amounts"),
    },
    buildTask: ({ client_info, items }) =>
      `Generate professional invoice content.\n\n` +
      `Client: ${client_info}\n` +
      `Items/services: ${items}\n\n` +
      `Provide: a clean, professional invoice layout in text — header, line items, totals, payment terms.`,
  },

  burn_rate_runway_calculator: {
    agent: "cfo",
    description:
      "Given cash balance, monthly revenue, and monthly expenses, compute exact net burn rate and cash runway in months.",
    inputSchema: {
      cash_balance: z.string().describe("Current cash on hand (e.g. '₹25L')"),
      monthly_revenue: z.string().describe("Average monthly revenue, or '0' if pre-revenue"),
      monthly_expenses: z.string().describe("Average monthly total expenses"),
    },
    buildTask: ({ cash_balance, monthly_revenue, monthly_expenses }) =>
      `Calculate burn rate and runway using a verified deterministic calculation.\n\n` +
      `Cash balance: ${cash_balance}\n` +
      `Monthly revenue: ${monthly_revenue}\n` +
      `Monthly expenses: ${monthly_expenses}\n\n` +
      `Provide: net burn rate, whether the business is profitable, and exact runway in months if not profitable.`,
  },

  break_even_calculator: {
    agent: "cfo",
    description:
      "Given fixed costs, price per unit, and variable cost per unit, compute the exact break-even point in units and revenue.",
    inputSchema: {
      fixed_costs: z.string().describe("Total fixed costs for the period"),
      price_per_unit: z.string().describe("Selling price per unit"),
      variable_cost_per_unit: z.string().describe("Variable cost per unit"),
    },
    buildTask: ({ fixed_costs, price_per_unit, variable_cost_per_unit }) =>
      `Calculate the break-even point using a verified deterministic calculation.\n\n` +
      `Fixed costs: ${fixed_costs}\n` +
      `Price per unit: ${price_per_unit}\n` +
      `Variable cost per unit: ${variable_cost_per_unit}\n\n` +
      `Provide: break-even units, break-even revenue, and contribution margin per unit.`,
  },

  mrr_growth_calculator: {
    agent: "cfo",
    description:
      "Given current and previous MRR, compute exact month-over-month growth rate and annualized ARR.",
    inputSchema: {
      current_mrr: z.string().describe("Current month's MRR"),
      previous_mrr: z.string().describe("Previous month's MRR"),
    },
    buildTask: ({ current_mrr, previous_mrr }) =>
      `Calculate MRR growth using a verified deterministic calculation.\n\n` +
      `Current MRR: ${current_mrr}\n` +
      `Previous MRR: ${previous_mrr}\n\n` +
      `Provide: month-over-month growth percentage and annualized ARR.`,
  },

  rule_of_40_calculator: {
    agent: "cfo",
    description:
      "Given revenue growth rate and profit margin, compute the Rule of 40 score used by investors to judge SaaS growth efficiency.",
    inputSchema: {
      revenue_growth_pct: z.string().describe("Revenue growth rate as a percentage, e.g. '30' for 30%"),
      profit_margin_pct: z.string().describe("Profit margin as a percentage, can be negative, e.g. '-10' for -10%"),
    },
    buildTask: ({ revenue_growth_pct, profit_margin_pct }) =>
      `Calculate the Rule of 40 score using a verified deterministic calculation.\n\n` +
      `Revenue growth: ${revenue_growth_pct}%\n` +
      `Profit margin: ${profit_margin_pct}%\n\n` +
      `Provide: the combined score and whether it passes the 40 threshold, with context on what that means.`,
  },

  liquidity_ratio_calculator: {
    agent: "cfo",
    description:
      "Given current assets and current liabilities, compute the exact current ratio (liquidity health check).",
    inputSchema: {
      current_assets: z.string().describe("Total current assets"),
      current_liabilities: z.string().describe("Total current liabilities"),
    },
    buildTask: ({ current_assets, current_liabilities }) =>
      `Calculate the current ratio using a verified deterministic calculation.\n\n` +
      `Current assets: ${current_assets}\n` +
      `Current liabilities: ${current_liabilities}\n\n` +
      `Provide: the current ratio and whether it indicates healthy liquidity.`,
  },

  valuation_estimator: {
    agent: "cfo",
    description:
      "Given ARR and a revenue multiple, compute a simple revenue-multiple valuation estimate.",
    inputSchema: {
      arr: z.string().describe("Annual recurring revenue"),
      multiple: z.string().describe("Revenue multiple to apply, e.g. '6' for a 6x multiple"),
    },
    buildTask: ({ arr, multiple }) =>
      `Estimate valuation using a verified deterministic calculation.\n\n` +
      `ARR: ${arr}\n` +
      `Multiple: ${multiple}x\n\n` +
      `Provide: the estimated valuation, clearly noting this is a rough estimate dependent on the multiple assumption, not a substitute for a full valuation.`,
  },
};

// agents/tools/sales-tools.js — Structured tool definitions for the Sales agent
// Aeldorado by Solanacy Technologies

import { z } from "zod";

export const SALES_TOOLS = {
  cold_outreach_generator: {
    agent: "sales",
    description:
      "Generate a personalized cold outreach email/LinkedIn message from prospect and product info.",
    inputSchema: {
      prospect_info: z.string().describe("Prospect name, role, company, and any known context"),
      product_info: z.string().describe("What you're selling and its key value proposition"),
    },
    buildTask: ({ prospect_info, product_info }) =>
      `Write a personalized cold outreach message.\n\n` +
      `Prospect: ${prospect_info}\n` +
      `Product: ${product_info}\n\n` +
      `Provide: one email version and one shorter LinkedIn message version, both personalized and non-generic.`,
  },

  sales_pitch_builder: {
    agent: "sales",
    description:
      "Build full pitch deck content from product and target audience info.",
    inputSchema: {
      product_info: z.string().describe("Product/service description and key differentiators"),
      target_audience: z.string().describe("Who the pitch is for — segment, persona, or company type"),
    },
    buildTask: ({ product_info, target_audience }) =>
      `Build full pitch content.\n\n` +
      `Product: ${product_info}\n` +
      `Target audience: ${target_audience}\n\n` +
      `Provide: slide-by-slide pitch deck content (problem, solution, value prop, differentiation, ask) ready to drop into a deck.`,
  },

  deal_analyzer: {
    agent: "sales",
    description:
      "Analyze deal details to compute a verified, weighted win-probability score (not a guess) and recommend next steps.",
    inputSchema: {
      deal_details: z.string().describe("Deal stage, stakeholders, objections, history, deal size etc. — include as much detail on budget, decision-maker involvement, urgency, timeline, and engagement as available so the scoring is accurate."),
    },
    buildTask: ({ deal_details }) =>
      `Analyze this deal using a verified deterministic deal-score calculation, not a free-text guess.\n\n` +
      `Deal details: ${deal_details}\n\n` +
      `Provide: the weighted deal score and tier (hot/warm/cool/cold) with a breakdown by factor, the specific risk factors it flagged, the confidence level of this score (state plainly if some factors were inferred rather than directly confirmed), and concrete next steps to move it forward. If any objection is mentioned in the deal details, ground your response strategy in the matched objection framework rather than inventing one.`,
  },

  deal_score_calculator: {
    agent: "sales",
    description:
      "Given budget, authority, need urgency, timeline, and engagement signals, compute an exact weighted deal score (0-100) and tier — not an estimate.",
    inputSchema: {
      budget_confirmed: z.string().describe("How confirmed/available budget is — describe qualitatively (e.g. 'budget approved and allocated' or 'no budget discussion yet')"),
      authority_level: z.string().describe("Decision-maker involvement level — describe qualitatively (e.g. 'talking directly to the VP who signs off' or 'only spoken to an individual contributor')"),
      need_urgency: z.string().describe("How pressing the prospect's pain point is"),
      timeline_fit: z.string().describe("How well their buying timeline aligns with a realistic close"),
      engagement_signals: z.string().describe("Responsiveness, meeting attendance, multi-stakeholder engagement"),
    },
    buildTask: ({ budget_confirmed, authority_level, need_urgency, timeline_fit, engagement_signals }) =>
      `Calculate the deal score using a verified deterministic calculation.\n\n` +
      `Budget confirmed: ${budget_confirmed}\n` +
      `Authority level: ${authority_level}\n` +
      `Need urgency: ${need_urgency}\n` +
      `Timeline fit: ${timeline_fit}\n` +
      `Engagement signals: ${engagement_signals}\n\n` +
      `Provide: the weighted score (0-100), tier (hot/warm/cool/cold), factor-by-factor breakdown, any flagged risk factors, and the confidence level of the score (whether these factors were clearly confirmed or loosely inferred).`,
  },

  forecast_calculator: {
    agent: "sales",
    description:
      "Given a list of pipeline deals with value and stage-close-probability, compute the exact stage-weighted revenue forecast.",
    inputSchema: {
      deals: z.string().describe("List of deals with their value and stage-close-probability, e.g. 'Deal A: ₹5L at 60% probability, Deal B: ₹2L at 30% probability'"),
    },
    buildTask: ({ deals }) =>
      `Calculate the stage-weighted pipeline forecast using a verified deterministic calculation.\n\n` +
      `Deals: ${deals}\n\n` +
      `Provide: total pipeline value, the weighted forecast total, and a per-deal breakdown.`,
  },

  quota_tracker: {
    agent: "sales",
    description:
      "Given closed revenue, weighted pipeline value, and quota target, compute exact current and projected quota attainment percentage and gap.",
    inputSchema: {
      closed_revenue: z.string().describe("Revenue already closed/won this period"),
      weighted_pipeline_value: z.string().describe("Stage-weighted value of remaining open pipeline"),
      quota_target: z.string().describe("The quota target for the period"),
    },
    buildTask: ({ closed_revenue, weighted_pipeline_value, quota_target }) =>
      `Calculate quota attainment using a verified deterministic calculation.\n\n` +
      `Closed revenue: ${closed_revenue}\n` +
      `Weighted pipeline value: ${weighted_pipeline_value}\n` +
      `Quota target: ${quota_target}\n\n` +
      `Provide: current attainment %, projected attainment % including pipeline, the exact gap to target, and whether it's on track.`,
  },

  sales_velocity_calculator: {
    agent: "sales",
    description:
      "Given number of opportunities, win rate, average deal size, and sales cycle length, compute the exact sales velocity (revenue per day) using the standard SaaS formula.",
    inputSchema: {
      opportunities: z.string().describe("Number of qualified open opportunities"),
      win_rate: z.string().describe("Win rate as a percentage, e.g. '25' for 25%"),
      avg_deal_size: z.string().describe("Average deal value"),
      sales_cycle_days: z.string().describe("Average sales cycle length in days"),
    },
    buildTask: ({ opportunities, win_rate, avg_deal_size, sales_cycle_days }) =>
      `Calculate sales velocity using a verified deterministic calculation.\n\n` +
      `Opportunities: ${opportunities}\n` +
      `Win rate: ${win_rate}%\n` +
      `Average deal size: ${avg_deal_size}\n` +
      `Sales cycle length: ${sales_cycle_days} days\n\n` +
      `Provide: the exact sales velocity (revenue generated per day) using the formula (opportunities x win rate x avg deal size) / sales cycle length.`,
  },

  objection_handler: {
    agent: "sales",
    description:
      "Given a specific prospect objection, match it to a proven counter-framework (not invented each time) and produce a personalized response.",
    inputSchema: {
      objection: z.string().describe("The prospect's objection, in their own words or paraphrased"),
      deal_context: z.string().optional().describe("Relevant deal context to personalize the response (product, prospect details, deal history)"),
    },
    buildTask: ({ objection, deal_context }) =>
      `Handle this sales objection.\n\n` +
      `Objection: ${objection}\n` +
      `Deal context: ${deal_context || "not provided"}\n\n` +
      `Provide: the matched objection category and framework if one applies, and a personalized response script grounded in that framework (not an invented strategy).`,
  },
};

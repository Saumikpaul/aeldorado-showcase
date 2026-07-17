// agents/tools/research-tools.js — Structured tool definitions for the Research agent
// Aeldorado by Solanacy Technologies

import { z } from "zod";

export const RESEARCH_TOOLS = {
  competitor_intelligence_report: {
    agent: "research",
    description:
      "Given a competitor name, produce a full strengths/weaknesses/pricing analysis.",
    inputSchema: {
      competitor_name: z.string().describe("Name of the competitor to research"),
      context: z.string().optional().describe("Your own product/market context, if relevant"),
    },
    buildTask: ({ competitor_name, context }) =>
      `Produce a competitor intelligence report.\n\n` +
      `Competitor: ${competitor_name}\n` +
      `Context: ${context || "not provided"}\n\n` +
      `Provide: strengths, weaknesses, pricing analysis (estimate clearly labeled if not certain), and strategic implications.`,
  },

  market_size_estimator: {
    agent: "research",
    description:
      "Given an industry and geography, produce a TAM/SAM/SOM breakdown.",
    inputSchema: {
      industry: z.string().describe("Industry or product category"),
      geography: z.string().describe("Target geography or market scope"),
    },
    buildTask: ({ industry, geography }) =>
      `Estimate market size.\n\n` +
      `Industry: ${industry}\n` +
      `Geography: ${geography}\n\n` +
      `Provide: TAM/SAM/SOM breakdown with methodology and clearly labeled assumptions.`,
  },

  trend_spotter: {
    agent: "research",
    description:
      "Given a topic, surface emerging trends and opportunities.",
    inputSchema: {
      topic: z.string().describe("Topic, industry, or domain to scan for trends"),
    },
    buildTask: ({ topic }) =>
      `Spot emerging trends and opportunities.\n\n` +
      `Topic: ${topic}\n\n` +
      `Provide: key emerging trends, why they matter, and concrete opportunities they open up.`,
  },
};

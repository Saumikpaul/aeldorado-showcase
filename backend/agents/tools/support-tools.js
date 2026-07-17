// agents/tools/support-tools.js — Structured tool definitions for the Support agent
// Aeldorado by Solanacy Technologies

import { z } from "zod";

export const SUPPORT_TOOLS = {
  faq_generator: {
    agent: "support",
    description:
      "Generate 20 FAQs with answers from product info — ready for a knowledge base or help center.",
    inputSchema: {
      product_info: z.string().describe("Product/service description, key features, common pain points"),
    },
    buildTask: ({ product_info }) =>
      `Generate a comprehensive FAQ set.\n\n` +
      `Product info: ${product_info}\n\n` +
      `Provide: exactly 20 frequently asked questions with clear, helpful answers, covering setup, usage, billing, troubleshooting, and common concerns. Format as Q&A pairs.`,
  },

  customer_response_templates: {
    agent: "support",
    description:
      "Given a support situation, generate an empathetic, solution-oriented customer response template.",
    inputSchema: {
      situation: z.string().describe("Describe the customer situation — complaint, issue, request, tone, context"),
    },
    buildTask: ({ situation }) =>
      `Write an empathetic customer response template for this situation.\n\n` +
      `Situation: ${situation}\n\n` +
      `Provide: a warm, solution-oriented response template the support team can adapt — acknowledge the issue, show empathy, offer a clear path forward.`,
  },
};

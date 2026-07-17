// agents/tools/register-structured-tools.js — Wires lazy-loaded structured
// tools (financial_health_checker, cold_outreach_generator, etc.) onto an
// MCP server instance.
// Aeldorado by Solanacy Technologies
//
// Design: the tool *definitions* (description, zod schema, task builder)
// live in cfo-tools.js / sales-tools.js / research-tools.js and are only
// imported via getToolRegistry() the first time this function runs — not
// eagerly bundled at module load in routes/mcp.js. This keeps the MCP route
// file from growing into a 9-tool-deep wall of inline schemas, and means
// the domain prompt logic only enters memory when an MCP session actually
// gets created.
//
// Each registered tool delegates the actual run (auth, usage check, memory
// context, agent call, usage record, request log) to the shared
// `runAgentTask` helper passed in from mcp.js — no duplicated plumbing.

import { z } from "zod";
import { logger } from "../../core/logger.js";
import { getToolRegistry } from "./tool-registry.js";

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {(args: { agent: string, task: string, provider?: string, model?: string, routing: string }) => Promise<any>} runAgentTask
 */
export async function registerStructuredTools(server, runAgentTask) {
  let registry;
  try {
    registry = await getToolRegistry();
  } catch (e) {
    logger.error("[MCP] Failed to load structured tool registry", { error: e.message });
    return;
  }

  for (const [name, def] of Object.entries(registry)) {
    server.tool(
      name,
      def.description,
      {
        ...def.inputSchema,
        provider: z.enum(["gemini", "openai", "anthropic"]).optional().describe("AI provider (default: gemini)"),
        model: z.string().optional().describe("Specific model to use"),
      },
      async (input) => {
        try {
          const { provider, model, ...rest } = input;
          const task = def.buildTask(rest);
          return await runAgentTask({
            agent: def.agent,
            task,
            provider,
            model,
            routing: `tool:${name}`,
          });
        } catch (e) {
          logger.error(`[MCP] structured tool error: ${name}`, { error: e.message });
          return { content: [{ type: "text", text: `❌ Tool error: ${e.message}` }], isError: true };
        }
      }
    );
  }

  logger.info("[MCP] Structured tools registered", { count: Object.keys(registry).length, tools: Object.keys(registry) });
}

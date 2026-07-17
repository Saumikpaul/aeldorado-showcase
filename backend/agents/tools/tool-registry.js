// agents/tools/tool-registry.js — Central registry for structured agent tools
// Aeldorado by Solanacy Technologies
//
// Each "tool" here is a sharply-scoped task wrapper around an existing
// agent runner (runCFOAgent, runSalesAgent, runResearchAgent) — not a
// separate agent. Domain files (cfo-tools.js, sales-tools.js,
// research-tools.js) are only imported lazily, the first time a tool
// from that domain is actually invoked — keeping startup light and
// avoiding loading schemas/descriptions for tools nobody calls.

let _registry = null;     // name -> { agent, description, inputSchema, buildTask }
let _agentRunners = null; // agent name -> runner fn (cfo/sales/research only)

async function loadDomain(domain) {
  switch (domain) {
    case "cfo": {
      const { CFO_TOOLS } = await import("./cfo-tools.js");
      const { runCFOAgent } = await import("../cfo.js");
      return { tools: CFO_TOOLS, runner: runCFOAgent };
    }
    case "sales": {
      const { SALES_TOOLS } = await import("./sales-tools.js");
      const { runSalesAgent } = await import("../sales.js");
      return { tools: SALES_TOOLS, runner: runSalesAgent };
    }
    case "research": {
      const { RESEARCH_TOOLS } = await import("./research-tools.js");
      const { runResearchAgent } = await import("../research.js");
      return { tools: RESEARCH_TOOLS, runner: runResearchAgent };
    }
    case "support": {
      const { SUPPORT_TOOLS } = await import("./support-tools.js");
      const { runSupportAgent } = await import("../support.js");
      return { tools: SUPPORT_TOOLS, runner: runSupportAgent };
    }
    default:
      throw new Error(`Unknown tool domain: ${domain}`);
  }
}

const DOMAINS = ["cfo", "sales", "research", "support"];

/**
 * Build (once, cached) a flat map of every tool name -> definition,
 * by lazily importing each domain file. Subsequent calls are free —
 * this only does real work once per server lifetime.
 */
export async function getToolRegistry() {
  if (_registry) return _registry;

  _registry = {};
  _agentRunners = {};

  for (const domain of DOMAINS) {
    const { tools, runner } = await loadDomain(domain);
    _agentRunners[domain] = runner;
    for (const [name, def] of Object.entries(tools)) {
      _registry[name] = def;
    }
  }

  return _registry;
}

/**
 * Get the agent runner function for a given agent name ("cfo"/"sales"/"research").
 * Registry must be loaded first via getToolRegistry().
 */
export function getRunnerForAgent(agentName) {
  if (!_agentRunners) {
    throw new Error("Tool registry not loaded yet — call getToolRegistry() first.");
  }
  return _agentRunners[agentName];
}

/** List of all registered tool names — useful for logging/debugging. */
export async function listToolNames() {
  const registry = await getToolRegistry();
  return Object.keys(registry);
}

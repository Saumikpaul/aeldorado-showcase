// routes/mcp.js — MCP (Model Context Protocol) Server Endpoint
// Aeldorado by Solanacy Technologies
//
// Exposes all Aeldorado platform capabilities as MCP tools
// accessible to Claude Desktop, Claude Code, Cursor, VS Code, etc.
//
// Endpoint: POST/GET /mcp (Streamable HTTP transport)
// Auth: API key with scope "mcp" via Authorization header or query param

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import crypto from "crypto";

import { extractApiKey, verifyApiKey, verifyApiKeyHash, generateApiKey as generateApiKeyFn } from "../core/auth.js";
import { renderMcpPage } from "../core/mcp-page.js";
import { verifyAccessToken } from "../core/oauth.js";
import { sendError } from "../core/errors.js";
import { logger } from "../core/logger.js";
import { createAIClient } from "../core/ai-client.js";
import { orchestrate } from "../agents/orchestrator.js";
import { checkUsage, recordUsage, getUsageStats, TIER_LIMITS, checkSubscriptionValid } from "../core/billing.js";
import { listProviders, detectProvider, maskApiKey, getProviderModels } from "../core/provider-detect.js";
import { encrypt, decrypt, verifyDecryption } from "../core/encryption.js";
import { getRequestLogs, getUsageAnalytics } from "../core/request-log.js";
import { logRequest } from "../core/request-log.js";
import { getConversation, saveConversationTurn, buildContext } from "../core/conversation.js";
import { buildMemoryContext, addFactManually, getMemory, clearMemory, deleteFact, VALID_AGENTS } from "../core/memory.js";
import { createProject, listProjects as listProjectsFn, deleteProject, getProject, canUseMemory } from "../core/project-manager.js";
import { checkIPAllowed, getUserDoc, ensureUser } from "../core/user-manager.js";
import { checkAbuse } from "../core/anti-abuse.js";

import { runCEOAgent } from "../agents/ceo.js";
import { runCFOAgent } from "../agents/cfo.js";
import { runSalesAgent } from "../agents/sales.js";
import { runSupportAgent } from "../agents/support.js";
import { runResearchAgent } from "../agents/research.js";
import { runMarketingAgent } from "../agents/marketing.js";
import { runLegalAgent } from "../agents/legal.js";
import { registerStructuredTools } from "../agents/tools/register-structured-tools.js";

const AGENT_RUNNERS = {
  ceo: runCEOAgent,
  cfo: runCFOAgent,
  sales: runSalesAgent,
  support: runSupportAgent,
  research: runResearchAgent,
  marketing: runMarketingAgent,
  legal: runLegalAgent,
};

// Valid scopes including the new "mcp" scope
const VALID_AGENTS_LIST = ["ceo", "cfo", "sales", "support", "research", "marketing", "legal"];
const VALID_SCOPES = ["all", "auto", "mcp", ...VALID_AGENTS_LIST.map(a => `agent:${a}`)];

// ── Session Manager ──────────────────────────────────────────────────────────
// Tracks active MCP sessions (transport + server per session)
const sessions = new Map();

// Cleanup stale sessions every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > 30 * 60 * 1000) {
      session.transport.close?.();
      sessions.delete(id);
      logger.info("[MCP] Session expired", { sessionId: id });
    }
  }
}, 30 * 60 * 1000);

// ── Create MCP Server Instance ───────────────────────────────────────────────
// ── Helper: Get provider key from MCP vault (no vault password needed) ───────
// Tries mcp_vault first (re-encrypted with MCP_SERVER_SECRET).
// Falls back to user's main vault if _vaultPassword is present.
async function getMcpProviderKey(db, userId, keyDoc, providerName) {
  const MCP_SERVER_SECRET = process.env.MCP_SERVER_SECRET || null;

  // 1. Try mcp_vault first
  if (MCP_SERVER_SECRET) {
    const mcpSnap = await db.collection("mcp_vault").doc(userId).get();
    if (mcpSnap.exists) {
      const providers = mcpSnap.data().providers || [];
      const entry = providers.find(p => p.name === providerName);
      if (entry) {
        const decryptedKey = decrypt({
          ciphertext: entry.ciphertext,
          iv: entry.iv,
          salt: entry.salt,
          tag: entry.tag,
        }, MCP_SERVER_SECRET);
        return { key: decryptedKey, entry, source: "mcp_vault" };
      }
      // mcp_vault exists but no entry for this provider
      const available = providers.map(p => p.name).join(", ");
      return { error: `❌ Provider "${providerName}" not in MCP vault. Available: ${available || "none"}.\n\nGo to Dashboard → Settings → MCP Agent Access → Sync to update.` };
    }
    // mcp_vault not set up at all
    return { error: `❌ MCP Agent Access not enabled. Go to Dashboard → Settings → MCP Agent Access and click Enable.` };
  }

  // 2. Fallback: legacy vault password header (for direct API key users)
  const vaultPassword = keyDoc._vaultPassword;
  if (vaultPassword) {
    const vaultSnap = await db.collection("key_vault").doc(userId).get();
    if (!vaultSnap.exists) {
      return { error: "❌ No API keys in vault." };
    }
    const providers = vaultSnap.data().providers || [];
    const entry = providers.find(p => p.name === providerName);
    if (!entry) {
      return { error: `❌ No key found for provider "${providerName}". Available: ${providers.map(p => p.name).join(", ")}` };
    }
    const key = decrypt({ ciphertext: entry.ciphertext, iv: entry.iv, salt: entry.salt, tag: entry.tag }, vaultPassword);
    return { key, entry, source: "vault_header" };
  }

  return { error: "❌ MCP Agent Access not enabled. Go to Dashboard → Settings → MCP Agent Access and click Enable." };
}

async function createMcpServer(db, adminAuth, userId, keyDoc, userData) {
  const server = new McpServer({
    name: "aeldorado",
    version: "1.0.0",
    description: "Aeldorado — The Legendary Intelligence. Multi-agent AI platform by Solanacy Technologies.",
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOLS
  // ════════════════════════════════════════════════════════════════════════════

  // ── Tool: chat ─────────────────────────────────────────────────────────────
  server.tool(
    "chat",
    "Send a message to the Aeldorado CEO orchestrator. The CEO analyzes your request and intelligently routes it to 1-3 specialized agents (CFO, Sales, Support, Research, Marketing, Legal), runs them in parallel, and synthesizes a unified response.",
    {
      message: z.string().describe("Your message or question"),
      provider: z.enum(["gemini", "openai", "anthropic"]).optional().describe("AI provider to use (default: gemini)"),
      model: z.string().optional().describe("Specific model to use (e.g., gemini-2.5-flash)"),
    },
    async ({ message, provider, model }) => {
      const startTime = Date.now();
      try {
        const providerName = provider || "gemini";

        // Get provider key from mcp_vault (no vault password needed)
        const providerResult = await getMcpProviderKey(db, userId, keyDoc, providerName);
        if (providerResult.error) {
          return { content: [{ type: "text", text: providerResult.error }], isError: true };
        }
        const { key: decryptedKey, entry: providerEntry } = providerResult;

        const ai = createAIClient(providerName, decryptedKey);
        const resolvedModel = model || providerEntry.defaultModel || null;

        // Check usage
        const tier = userData?.tier || keyDoc.tier || "free";
        const usageResult = await checkUsage(db, userId, tier);
        if (!usageResult.allowed) {
          return { content: [{ type: "text", text: `❌ Usage limit exceeded: ${usageResult.limitType} limit reached on ${TIER_LIMITS[tier]?.name || tier} plan.` }], isError: true };
        }

        // Memory context
        const projectId = keyDoc.projectId || null;
        let memoryContext = "";
        if (projectId && canUseMemory(tier)) {
          try {
            const projSnap = await db.collection("projects").doc(projectId).get();
            if (projSnap.exists && projSnap.data().memoryEnabled) {
              memoryContext = await buildMemoryContext(db, projectId, { agentName: "ceo", isPublicFacing: keyDoc.isPublicFacing === true });
            }
          } catch (e) { /* ignore memory errors */ }
        }

        const fullMessage = memoryContext ? memoryContext + message : message;

        const result = await orchestrate({
          prompt: fullMessage,
          ai,
          model: resolvedModel,
          options: {},
          memoryWrite: {
            db,
            projectId,
            allowed: false, // MCP doesn't auto-write memory
            agentName: "ceo",
            visibility: "internal",
          },
        });

        await recordUsage(db, userId).catch(() => {});

        const responseText = result.response_to_user || result.summary || JSON.stringify(result);

        // Log request — single "ceo" entry, with a per-sub-agent breakdown
        // (name + real latency each) when the CEO dispatched to
        // CFO/Sales/Support/Research/Marketing/Legal instead of answering directly.
        await logRequest(db, {
          userId,
          keyPrefix: keyDoc.keyPrefix,
          agent: result.agentUsed || "ceo",
          model: resolvedModel || "default",
          provider: providerName,
          projectId,
          routing: "auto",
          status: "success",
          latencyMs: Date.now() - startTime,
          tokens: result.tokens || {},
          subAgents: result.subAgents || [],
          ip: "mcp",
        }).catch(() => {});

        return {
          content: [{ type: "text", text: responseText }],
        };
      } catch (e) {
        logger.error("[MCP] chat tool error", { error: e.message, userId });
        return { content: [{ type: "text", text: `❌ Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Shared helper: run any agent task (used by call_agent + structured tools) ─
  // Centralizes provider-key lookup, usage check, memory context, the actual
  // agent run, usage recording, and request logging — so call_agent and every
  // structured tool (financial_health_checker, cold_outreach_generator, etc.)
  // share one code path instead of duplicating it per tool.
  async function runAgentTask({ agent, task, provider, model, routing }) {
    const startTime = Date.now();
    const providerName = provider || "gemini";

    const providerResult = await getMcpProviderKey(db, userId, keyDoc, providerName);
    if (providerResult.error) {
      return { content: [{ type: "text", text: providerResult.error }], isError: true };
    }
    const { key: decryptedKey, entry: providerEntry } = providerResult;

    const ai = createAIClient(providerName, decryptedKey);
    const resolvedModel = model || providerEntry.defaultModel || null;

    // Check usage
    const tier = userData?.tier || keyDoc.tier || "free";
    const usageResult = await checkUsage(db, userId, tier);
    if (!usageResult.allowed) {
      return { content: [{ type: "text", text: `❌ Usage limit exceeded: ${usageResult.limitType} limit.` }], isError: true };
    }

    // Memory context injection — respects the key's actual public-facing flag,
    // same as routes/agents.js and routes/chat.js do. A public-facing key only
    // ever sees memory facts explicitly marked visibility:"public"; internal
    // facts are filtered out by buildMemoryContext itself.
    const projectId = keyDoc.projectId || null;
    const isPublicFacing = keyDoc.isPublicFacing === true;
    let memoryContext = "";
    if (projectId && canUseMemory(tier)) {
      try {
        const projSnap = await db.collection("projects").doc(projectId).get();
        const projData = projSnap.exists ? projSnap.data() : null;
        if (projSnap.exists && projData.memoryEnabled) {
          memoryContext = await buildMemoryContext(db, projectId, { agentName: agent, isPublicFacing });
        }
      } catch (e) {
        logger.error(`[MCP] ${routing} memory error`, { error: e.message });
      }
    }

    const fullTask = memoryContext ? memoryContext + task : task;

    const runner = AGENT_RUNNERS[agent];
    const result = await runner({
      task: fullTask,
      rawMessage: task,
      ai,
      model: resolvedModel,
      options: {},
    });

    await recordUsage(db, userId).catch(() => {});

    let responseText = result.response || result.resolution || result.analysis || result.summary || JSON.stringify(result);

    // Legal agent's schema keeps the mandatory disclaimer in its own
    // `disclaimer` field, separate from `response` — this line used to
    // return only `response`, so the disclaimer silently vanished on every
    // MCP call_agent/legal invocation whenever the model (correctly) put it
    // in its own field instead of repeating it inline. Legal's system
    // prompt says "ALWAYS INCLUDE" the disclaimer, so append it here if
    // it's present and not already part of the response text.
    if (agent === "legal" && result.disclaimer && !responseText.includes(result.disclaimer)) {
      responseText = `${responseText}\n\n${result.disclaimer}`;
    }

    await logRequest(db, {
      userId,
      keyPrefix: keyDoc.keyPrefix,
      agent,
      model: resolvedModel || "default",
      provider: providerName,
      projectId: keyDoc.projectId || null,
      routing,
      status: "success",
      latencyMs: Date.now() - startTime,
      tokens: result.tokens || {},
      ip: "mcp",
    }).catch(() => {});

    return { content: [{ type: "text", text: responseText }] };
  }

  // ── Tool: call_agent ───────────────────────────────────────────────────────
  server.tool(
    "call_agent",
    "Call a specific Aeldorado agent directly. Available agents: CEO (strategy), CFO (finance), Sales, Support (customer service), Research (market analysis), Marketing (content/campaigns), Legal (compliance/contracts).",
    {
      agent: z.enum(["ceo", "cfo", "sales", "support", "research", "marketing", "legal"]).describe("Which agent to call"),
      message: z.string().describe("Your message or task for the agent"),
      provider: z.enum(["gemini", "openai", "anthropic"]).optional().describe("AI provider (default: gemini)"),
      model: z.string().optional().describe("Specific model to use"),
    },
    async ({ agent, message, provider, model }) => {
      try {
        if (keyDoc.isPublicFacing === true && agent !== "ceo") {
          return { content: [{ type: "text", text: `❌ This API key is public-facing and can only call the "ceo" agent.` }], isError: true };
        }
        return await runAgentTask({ agent, task: message, provider, model, routing: "direct" });
      } catch (e) {
        logger.error("[MCP] call_agent error", { error: e.message, userId, agent });
        return { content: [{ type: "text", text: `❌ Agent error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Structured domain tools (CFO / Sales / Research / Support) — lazy-loaded
  // Tool definitions (description, input schema, task-builder) live in
  // ../agents/tools/*.js and are only imported the first time getToolRegistry()
  // runs, instead of being bundled into this file. Each one reuses
  // runAgentTask() above — no duplicated auth/usage/memory/logging code.
  // Public-facing keys must NOT get these internal-domain tools at all —
  // they're not just memory-filtered, they're not registered on the server.
  if (keyDoc.isPublicFacing !== true) {
    await registerStructuredTools(server, runAgentTask);
  } else {
    logger.info("[MCP] Structured tools skipped — public-facing key", { userId });
  }

  // ── Tool: list_keys ────────────────────────────────────────────────────────
  server.tool(
    "list_keys",
    "List all your Aeldorado API keys (masked for security). Shows scope, project, tier, and creation date.",
    {},
    async () => {
      try {
        const snap = await db.collection("api_keys").where("userId", "==", userId).get();
        const keys = snap.docs.map(doc => {
          const d = doc.data();
          return {
            prefix: d.keyPrefix,
            name: d.name,
            scope: d.scope,
            tier: d.tier,
            projectId: d.projectId || null,
            isPlaygroundKey: d.isPlaygroundKey || false,
            isPublicFacing: d.isPublicFacing || false,
            createdAt: d.createdAt,
            lastUsed: d.lastUsed || null,
          };
        });

        const text = keys.length === 0
          ? "No API keys found."
          : keys.map((k, i) => `${i + 1}. **${k.name}** (${k.prefix}••••)\n   Scope: ${k.scope} | Tier: ${k.tier} | Project: ${k.projectId || "none"}\n   Created: ${k.createdAt} | Last used: ${k.lastUsed || "never"}`).join("\n\n");

        return { content: [{ type: "text", text: `📋 **API Keys** (${keys.length} total)\n\n${text}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Tool: generate_key ─────────────────────────────────────────────────────
  server.tool(
    "generate_key",
    "Generate a new Aeldorado API key. The key will be shown ONCE — save it immediately. Max 10 keys per account.",
    {
      name: z.string().optional().describe("Name for the key (e.g., 'Production Key')"),
      scope: z.enum(["all", "auto", "mcp", "agent:ceo", "agent:cfo", "agent:sales", "agent:support", "agent:research", "agent:marketing", "agent:legal"]).optional().describe("Key scope (default: all)"),
      project_id: z.string().optional().describe("Project ID to link this key to"),
    },
    async ({ name, scope, project_id }) => {
      try {
        const existingSnap = await db.collection("api_keys").where("userId", "==", userId).get();
        const activeCount = existingSnap.docs.filter(d => d.data().isActive === true).length;
        if (activeCount >= 10) {
          return { content: [{ type: "text", text: "❌ Maximum 10 active API keys per account." }], isError: true };
        }

        if (project_id) {
          const projSnap = await db.collection("projects").doc(project_id).get();
          if (!projSnap.exists || projSnap.data().userId !== userId) {
            return { content: [{ type: "text", text: "❌ Project not found or doesn't belong to you." }], isError: true };
          }
        }

        const keyScope = scope || "all";
        const tier = userData?.tier || "free";
        const { raw, hash, prefix } = generateApiKeyFn();

        await db.collection("api_keys").doc(hash).set({
          userId,
          rawKey: raw,
          keyPrefix: prefix,
          name: name || `MCP Key ${activeCount + 1}`,
          scope: keyScope,
          tier,
          isActive: true,
          projectId: project_id || null,
          isPlaygroundKey: false,
          isPublicFacing: false,
          createdAt: new Date().toISOString(),
          lastUsed: null,
        });

        return {
          content: [{ type: "text", text: `🔑 **New API Key Generated**\n\n\`${raw}\`\n\n⚠️ **Save this key NOW — it will never be shown again!**\n\nName: ${name || `MCP Key ${activeCount + 1}`}\nScope: ${keyScope}\nTier: ${tier}\nProject: ${project_id || "none"}` }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Tool: revoke_key ───────────────────────────────────────────────────────
  server.tool(
    "revoke_key",
    "Revoke (permanently delete) an API key by its prefix. This action cannot be undone.",
    {
      key_prefix: z.string().describe("The key prefix to revoke (e.g., 'aldo-live-xxxx')"),
    },
    async ({ key_prefix }) => {
      try {
        const snap = await db.collection("api_keys")
          .where("userId", "==", userId)
          .where("keyPrefix", "==", key_prefix)
          .limit(1)
          .get();

        if (snap.empty) {
          return { content: [{ type: "text", text: `❌ No key found with prefix "${key_prefix}".` }], isError: true };
        }

        await snap.docs[0].ref.delete();
        return { content: [{ type: "text", text: `🗑️ Key \`${key_prefix}\` has been permanently revoked.` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Tool: list_vault ───────────────────────────────────────────────────────
  server.tool(
    "list_vault",
    "List stored AI provider keys in your encrypted vault. Shows provider name, masked key, and default model (no sensitive data exposed).",
    {},
    async () => {
      try {
        const vaultSnap = await db.collection("key_vault").doc(userId).get();
        if (!vaultSnap.exists) {
          return { content: [{ type: "text", text: "🔐 Vault is empty. No AI provider keys stored." }] };
        }

        const providers = (vaultSnap.data().providers || []).map(p => ({
          name: p.name,
          displayName: p.displayName,
          icon: p.icon,
          masked: p.masked,
          defaultModel: p.defaultModel,
          models: getProviderModels(p.name) || p.models || [],
        }));

        const text = providers.map(p =>
          `${p.icon} **${p.displayName}** (${p.name})\n   Key: ${p.masked}\n   Default model: ${p.defaultModel || "auto"}\n   Available models: ${p.models.map(m => m.id || m).join(", ")}`
        ).join("\n\n");

        return { content: [{ type: "text", text: `🔐 **Vault** (${providers.length} providers)\n\n${text}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Tool: store_vault_key ──────────────────────────────────────────────────
  server.tool(
    "store_vault_key",
    "Store an AI provider API key in your encrypted vault. The key is encrypted with your vault password (AES-256-GCM) and never stored in plaintext.",
    {
      api_key: z.string().describe("The AI provider API key to store"),
      provider: z.enum(["gemini", "openai", "anthropic"]).optional().describe("Provider name (auto-detected if not specified)"),
      default_model: z.string().optional().describe("Default model for this provider"),
    },
    async ({ api_key, provider, default_model }) => {
      try {
        const vaultPassword = keyDoc._vaultPassword;
        if (!vaultPassword) {
          return { content: [{ type: "text", text: "❌ Vault password not set. Provide X-Vault-Password header." }], isError: true };
        }

        const detected = detectProvider(api_key);
        const providerName = provider || detected?.provider;
        if (!providerName) {
          return { content: [{ type: "text", text: "❌ Could not detect provider. Please specify the 'provider' parameter." }], isError: true };
        }

        const encrypted = encrypt(api_key, vaultPassword);
        const masked = maskApiKey(api_key);

        const vaultRef = db.collection("key_vault").doc(userId);
        const vaultSnap = await vaultRef.get();
        const existing = vaultSnap.exists ? (vaultSnap.data().providers || []) : [];

        const filtered = existing.filter(p => p.name !== providerName);
        filtered.push({
          name: providerName,
          displayName: detected?.name || providerName,
          icon: detected?.icon || "🔑",
          masked,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          salt: encrypted.salt,
          tag: encrypted.tag,
          defaultModel: default_model || detected?.defaultModel || null,
          models: detected?.models || [],
          createdAt: new Date().toISOString(),
        });

        await vaultRef.set({ providers: filtered }, { merge: true });

        return { content: [{ type: "text", text: `🔒 Key for **${detected?.name || providerName}** stored successfully!\nMasked: ${masked}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Tool: remove_vault_key ─────────────────────────────────────────────────
  server.tool(
    "remove_vault_key",
    "Remove an AI provider key from your encrypted vault.",
    {
      provider: z.enum(["gemini", "openai", "anthropic"]).describe("Provider to remove"),
    },
    async ({ provider }) => {
      try {
        const vaultRef = db.collection("key_vault").doc(userId);
        const vaultSnap = await vaultRef.get();
        if (!vaultSnap.exists) {
          return { content: [{ type: "text", text: "❌ Vault is empty." }], isError: true };
        }

        const providers = (vaultSnap.data().providers || []).filter(p => p.name !== provider);
        await vaultRef.set({ providers });

        return { content: [{ type: "text", text: `🗑️ Key for **${provider}** removed from vault.` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Tool: create_project ───────────────────────────────────────────────────
  server.tool(
    "create_project",
    "Create a new project. Projects group API keys under a shared memory pool for context-aware AI responses.",
    {
      name: z.string().describe("Project name"),
    },
    async ({ name }) => {
      try {
        const tier = userData?.tier || "free";
        const project = await createProject(db, userId, name, tier);
        return { content: [{ type: "text", text: `📁 **Project created!**\n\nID: \`${project.projectId}\`\nName: ${project.name}\nMemory available: ${canUseMemory(tier) ? "Yes" : "No (requires Starter+ tier)"}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Tool: list_projects ────────────────────────────────────────────────────
  server.tool(
    "list_projects",
    "List all your projects with their memory status and linked key count.",
    {},
    async () => {
      try {
        const projects = await listProjectsFn(db, userId);
        if (projects.length === 0) {
          return { content: [{ type: "text", text: "📁 No projects found. Create one with the create_project tool." }] };
        }

        const text = projects.map((p, i) =>
          `${i + 1}. **${p.name}** (\`${p.projectId}\`)\n   Memory: ${p.memoryEnabled ? "✅ Enabled" : "❌ Disabled"} | Created: ${p.createdAt}`
        ).join("\n\n");

        return { content: [{ type: "text", text: `📁 **Projects** (${projects.length})\n\n${text}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Tool: delete_project ───────────────────────────────────────────────────
  server.tool(
    "delete_project",
    "Delete a project and all its associated memory. This action cannot be undone.",
    {
      project_id: z.string().describe("Project ID to delete"),
    },
    async ({ project_id }) => {
      try {
        const deleted = await deleteProject(db, project_id, userId);
        if (!deleted) {
          return { content: [{ type: "text", text: "❌ Project not found or doesn't belong to you." }], isError: true };
        }
        return { content: [{ type: "text", text: `🗑️ Project \`${project_id}\` deleted.` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Tool: check_usage ──────────────────────────────────────────────────────
  server.tool(
    "check_usage",
    "Check your current API usage statistics and remaining limits. Field names are 'daily'/'weekly'/'monthly' for backward compatibility, but they are rolling windows: daily = 5-hour, weekly = 7-day, monthly = 28-day.",
    {},
    async () => {
      try {
        const tier = userData?.tier || keyDoc.tier || "free";
        const stats = await getUsageStats(db, userId, tier);
        return { content: [{ type: "text", text: `📊 **Usage Stats**\n\n${JSON.stringify(stats, null, 2)}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Tool: view_memory ──────────────────────────────────────────────────────
  server.tool(
    "view_memory",
    "View all stored memory facts for a project. Shows scope, visibility, and content of each fact.",
    {
      project_id: z.string().describe("Project ID to inspect memory for"),
    },
    async ({ project_id }) => {
      try {
        const projSnap = await db.collection("projects").doc(project_id).get();
        if (!projSnap.exists || projSnap.data().userId !== userId) {
          return { content: [{ type: "text", text: "❌ Project not found." }], isError: true };
        }

        const mem = await getMemory(db, project_id);
        if (!mem || !mem.facts?.length) {
          return { content: [{ type: "text", text: `🧠 No memory facts stored for project \`${project_id}\`.` }] };
        }

        const text = mem.facts.map((f, i) => {
          const fact = typeof f === "string" ? f : f.text || f.fact || JSON.stringify(f);
          const scope = f.scope || "universal";
          const vis = f.visibility || "internal";
          return `${i + 1}. [${scope}|${vis}] ${fact}`;
        }).join("\n");

        return { content: [{ type: "text", text: `🧠 **Memory** for \`${project_id}\` (${mem.facts.length} facts)\n\n${text}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Tool: remember_fact ────────────────────────────────────────────────────
  server.tool(
    "remember_fact",
    "Save a fact to project memory. Facts are used as context in future AI conversations for that project.",
    {
      project_id: z.string().describe("Project ID to save the fact to"),
      fact: z.string().describe("The fact to remember"),
      scope: z.string().optional().describe("Scope: 'universal' or 'agent:ceo', 'agent:cfo', etc."),
      visibility: z.enum(["internal", "public"]).optional().describe("Visibility: 'internal' or 'public'"),
    },
    async ({ project_id, fact, scope, visibility }) => {
      try {
        const projSnap = await db.collection("projects").doc(project_id).get();
        if (!projSnap.exists || projSnap.data().userId !== userId) {
          return { content: [{ type: "text", text: "❌ Project not found." }], isError: true };
        }

        const added = await addFactManually(db, project_id, fact.trim(), { scope, visibility });
        return {
          content: [{ type: "text", text: added
            ? `🧠 Fact remembered: "${fact.trim()}"\nScope: ${scope || "universal"} | Visibility: ${visibility || "internal"}`
            : `⚠️ Duplicate — this fact already exists in project memory.`
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Tool: add_memory ───────────────────────────────────────────────────────
  server.tool(
    "add_memory",
    "Add a fact to project memory with explicit scope and visibility control. Same as remember_fact but more explicit.",
    {
      project_id: z.string().describe("Project ID"),
      fact: z.string().describe("The fact to add"),
      scope: z.enum(["universal", "agent:ceo", "agent:cfo", "agent:sales", "agent:support", "agent:research", "agent:marketing", "agent:legal"]).optional().describe("Scope (default: universal)"),
      visibility: z.enum(["internal", "public"]).optional().describe("Visibility (default: internal)"),
    },
    async ({ project_id, fact, scope, visibility }) => {
      try {
        const projSnap = await db.collection("projects").doc(project_id).get();
        if (!projSnap.exists || projSnap.data().userId !== userId) {
          return { content: [{ type: "text", text: "❌ Project not found." }], isError: true };
        }

        const added = await addFactManually(db, project_id, fact.trim(), { scope, visibility });
        return {
          content: [{ type: "text", text: added
            ? `🧠 Memory added: "${fact.trim()}" [${scope || "universal"}|${visibility || "internal"}]`
            : `⚠️ Duplicate fact — already exists.`
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Tool: delete_memory ────────────────────────────────────────────────────
  server.tool(
    "delete_memory",
    "Delete a specific fact from project memory.",
    {
      project_id: z.string().describe("Project ID"),
      fact: z.string().describe("The exact fact text to delete"),
      scope: z.string().optional().describe("Scope of the fact to delete"),
    },
    async ({ project_id, fact, scope }) => {
      try {
        const projSnap = await db.collection("projects").doc(project_id).get();
        if (!projSnap.exists || projSnap.data().userId !== userId) {
          return { content: [{ type: "text", text: "❌ Project not found." }], isError: true };
        }

        const deleted = await deleteFact(db, project_id, fact, scope);
        return { content: [{ type: "text", text: deleted ? `🗑️ Fact deleted from memory.` : `⚠️ Fact not found in memory.` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Tool: billing_status ───────────────────────────────────────────────────
  server.tool(
    "billing_status",
    "Check your current subscription status, tier, expiry, and available plans.",
    {},
    async () => {
      try {
        const userDoc = await getUserDoc(db, userId);
        if (!userDoc) {
          return { content: [{ type: "text", text: "❌ User not found." }], isError: true };
        }

        const { valid, tier: effectiveTier, reason } = await checkSubscriptionValid(db, userId, userDoc);
        const tierInfo = TIER_LIMITS[effectiveTier] || TIER_LIMITS.free;

        const text = [
          `💳 **Billing Status**`,
          ``,
          `Tier: **${tierInfo.name}** (${effectiveTier})`,
          `Price: ₹${tierInfo.price}`,
          `Subscription valid: ${valid ? "✅ Yes" : "❌ No"}`,
          reason ? `Reason: ${reason}` : null,
          `Expiry: ${userDoc.subscriptionExpiry || "N/A"}`,
          ``,
          `**Limits:**`,
          `- 5-hour window: ${tierInfo.daily === Infinity ? "unlimited" : tierInfo.daily}`,
          `- 7-day window: ${tierInfo.weekly === Infinity ? "unlimited" : tierInfo.weekly}`,
          `- 28-day window: ${tierInfo.monthly === Infinity ? "unlimited" : tierInfo.monthly}`,
        ].filter(Boolean).join("\n");

        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Tool: view_logs ────────────────────────────────────────────────────────
  server.tool(
    "view_logs",
    "View your recent API request logs. Shows agent used, model, status, latency, and timestamps.",
    {
      limit: z.number().optional().describe("Number of logs to return (max 50, default 10)"),
      day: z.string().optional().describe("Filter by day (YYYY-MM-DD format, IST timezone)"),
    },
    async ({ limit, day }) => {
      try {
        const logLimit = Math.min(limit || 10, 50);
        const result = await getRequestLogs(db, userId, { limit: logLimit, dayKey: day || null, startAfter: null });

        if (!result.logs?.length) {
          return { content: [{ type: "text", text: "📝 No request logs found." }] };
        }

        const text = result.logs.map((log, i) => {
          let entry = `${i + 1}. [${log.timestamp}] ${log.agent || "?"} via ${log.provider || "?"} (${log.model || "?"})\n   Status: ${log.status} | Latency: ${log.latencyMs}ms`;
          if (log.subAgents && log.subAgents.length > 0) {
            const breakdown = log.subAgents
              .map(sa => `${sa.agent} (${sa.latencyMs != null ? sa.latencyMs + "ms" : "n/a"})`)
              .join(", ");
            entry += `\n   Dispatched to: ${breakdown}`;
          }
          return entry;
        }).join("\n\n");

        return { content: [{ type: "text", text: `📝 **Request Logs** (${result.logs.length})\n\n${text}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // RESOURCES
  // ════════════════════════════════════════════════════════════════════════════

  // ── Resource: providers ────────────────────────────────────────────────────
  server.resource(
    "providers",
    "aeldorado://providers",
    {
      description: "List of supported AI providers and their available models",
      mimeType: "application/json",
    },
    async () => ({
      contents: [{
        uri: "aeldorado://providers",
        mimeType: "application/json",
        text: JSON.stringify(listProviders(), null, 2),
      }],
    })
  );

  // ── Resource: usage ────────────────────────────────────────────────────────
  server.resource(
    "usage",
    "aeldorado://usage",
    {
      description: "Current API usage statistics and remaining limits",
      mimeType: "application/json",
    },
    async () => {
      const tier = userData?.tier || keyDoc.tier || "free";
      const stats = await getUsageStats(db, userId, tier);
      return {
        contents: [{
          uri: "aeldorado://usage",
          mimeType: "application/json",
          text: JSON.stringify(stats, null, 2),
        }],
      };
    }
  );

  // ── Resource: billing ──────────────────────────────────────────────────────
  server.resource(
    "billing",
    "aeldorado://billing",
    {
      description: "Current subscription tier, status, and plan details",
      mimeType: "application/json",
    },
    async () => {
      const userDoc = await getUserDoc(db, userId);
      const { valid, tier: effectiveTier, reason } = await checkSubscriptionValid(db, userId, userDoc || {});
      const tierInfo = TIER_LIMITS[effectiveTier] || TIER_LIMITS.free;

      return {
        contents: [{
          uri: "aeldorado://billing",
          mimeType: "application/json",
          text: JSON.stringify({
            tier: effectiveTier,
            tierName: tierInfo.name,
            subscriptionValid: valid,
            reason,
            limits: {
              daily: tierInfo.daily === Infinity ? "unlimited" : tierInfo.daily,
              weekly: tierInfo.weekly === Infinity ? "unlimited" : tierInfo.weekly,
              monthly: tierInfo.monthly === Infinity ? "unlimited" : tierInfo.monthly,
            },
          }, null, 2),
        }],
      };
    }
  );

  return server;
}

// ── MCP Auth: Validate API key OR OAuth access token with "mcp" scope ───────
async function mcpAuth(req, db, adminAuth) {
  // Extract bearer token from Authorization header or query param
  const authHeader = req.headers.authorization;
  let bearer = null;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    bearer = authHeader.slice(7).trim();
  }
  if (!bearer && req.query.api_key) {
    bearer = req.query.api_key; // fallback for SSE GET requests / legacy direct-key use
  }

  if (!bearer) {
    return { error: "Missing token. Set Authorization: Bearer <token> header, or connect via OAuth." };
  }

  let result;

  if (bearer.startsWith("aldo-at_")) {
    // OAuth access token — resolve to the underlying API key hash
    const tokenCheck = await verifyAccessToken(db, bearer);
    if (!tokenCheck.valid) {
      return { error: tokenCheck.expired ? "OAuth access token expired. Use the refresh_token to get a new one." : "Invalid OAuth access token." };
    }
    result = await verifyApiKeyHash(db, tokenCheck.apiKeyHash);
  } else if (bearer.startsWith("aldo-live-")) {
    // Legacy direct API key
    result = await verifyApiKey(db, bearer);
  } else {
    return { error: "Unrecognized token format." };
  }

  if (!result.valid) {
    return { error: "Invalid or revoked API key." };
  }

  // Check scope — must be "mcp" or "all"
  const scope = result.keyDoc?.scope;
  if (scope !== "mcp" && scope !== "all") {
    return { error: `API key scope is "${scope}" — MCP requires scope "mcp" or "all". Generate a new key with scope "mcp".` };
  }

  // Get vault password from header, fallback to env (for OAuth/MCP clients that can't set custom headers)
  const vaultPassword = req.headers["x-vault-password"] || req.headers["x-encryption-password"] || process.env.MCP_DEFAULT_VAULT_PASSWORD || null;

  // Attach vault password to keyDoc for tools to use
  const keyDoc = { ...result.keyDoc, _vaultPassword: vaultPassword };

  // Get user data
  let userData = null;
  try {
    userData = await getUserDoc(db, result.userId);
  } catch (e) { /* ignore */ }

  // Check subscription validity — free tier must be activated (₹1)
  // Only enforce if userData was successfully fetched; skip on error to avoid locking out users
  if (userData) {
    const { valid, reason } = await checkSubscriptionValid(db, result.userId, userData);
    if (!valid) {
      if (reason === "account_suspended") {
        return { error: "❌ Your account has been suspended. Please contact support." };
      }
      if (reason === "free_plan_not_activated") {
        return { error: "❌ Free tier not activated. Please pay the one-time ₹1 activation fee from the Aeldorado dashboard." };
      }
      if (reason === "subscription_expired") {
        return { error: "❌ Your subscription has expired. Please renew from the Aeldorado dashboard." };
      }
      if (reason !== "developer_plan_restricted") {
        return { error: "❌ Subscription inactive. Please visit the Aeldorado dashboard." };
      }
    }
  }

  return {
    userId: result.userId,
    keyDoc,
    userData,
  };
}
// ── Express Handler ──────────────────────────────────────────────────────────
// Handles POST /mcp (JSON-RPC requests), GET /mcp (SSE stream), DELETE /mcp (session end)
export function createMcpHandler(db, adminAuth) {
  return async (req, res) => {
    // ── Handle session-based requests ──────────────────────────────────────
    const sessionId = req.headers["mcp-session-id"];

    if (sessionId && sessions.has(sessionId)) {
      // Existing session — forward to transport
      const session = sessions.get(sessionId);
      session.lastActivity = Date.now();
      try {
        await session.transport.handleRequest(req, res, req.body);
      } catch (e) {
        logger.error("[MCP] Session request error", { error: e.message, sessionId });
        if (!res.headersSent) {
          res.status(500).json({ error: "MCP session error" });
        }
      }
      return;
    }

    // Unknown sessionId (e.g. after server restart)
    // If request is NOT initialize, reject so client re-initializes properly
    if (sessionId && !sessions.has(sessionId)) {
      const bodyMethod = req.body?.method;
      if (bodyMethod && bodyMethod !== "initialize") {
        logger.info("[MCP] Unknown sessionId, non-initialize request — rejecting so client re-initializes", { sessionId, bodyMethod });
        return res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found. Please re-initialize." },
          id: req.body?.id ?? null,
        });
      }
      logger.info("[MCP] Unknown sessionId (server restarted?) — allowing initialize to create new session", { sessionId });
      // Fall through to new session creation below
    }

    // ── New session — authenticate and create ──────────────────────────────
    if (req.method === "POST" || req.method === "GET") {
      const BASE_URL = process.env.PUBLIC_API_BASE_URL || "https://api.aeldorado.solanacy.in";

      // GET with no auth = either Claude.ai probing for WWW-Authenticate
      // (RFC 9728 discovery — sends Accept: application/json) or a human
      // opening the URL in a browser (sends Accept: text/html first). Real
      // MCP clients never prefer html, so this branch is safe to add.
      const authHeader = req.headers["authorization"];
      logger.info("[MCP] Incoming request", { method: req.method, hasAuth: !!authHeader, sessionId: req.headers["mcp-session-id"] || null, tokenPrefix: authHeader ? authHeader.slice(7, 20) + "..." : null });
      if (req.method === "GET" && !authHeader && !req.query.api_key) {
        const wantsHtml = req.accepts(["html", "json"]) === "html";
        if (wantsHtml) {
          return res.set("Content-Type", "text/html").send(renderMcpPage({ baseUrl: BASE_URL }));
        }
        res.setHeader(
          "WWW-Authenticate",
          `Bearer realm="${BASE_URL}/mcp", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`
        );
        return res.status(401).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Authorization required. Connect via OAuth or provide an API key." },
          id: null,
        });
      }

      const auth = await mcpAuth(req, db, adminAuth);
      logger.info("[MCP] mcpAuth result", { hasError: !!auth.error, error: auth.error || null, userId: auth.userId || null });
      if (auth.error) {
        // RFC 9728: include WWW-Authenticate so Claude.ai knows where to auth
        res.setHeader(
          "WWW-Authenticate",
          `Bearer realm="${BASE_URL}/mcp", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`
        );
        return res.status(401).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: auth.error },
          id: null,
        });
      }

      try {
        const server = await createMcpServer(db, adminAuth, auth.userId, auth.keyDoc, auth.userData);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, {
              transport,
              server,
              userId: auth.userId,
              lastActivity: Date.now(),
            });
            logger.info("[MCP] New session", { sessionId: newSessionId, userId: auth.userId });
          },
        });

        // Clean up on close
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.has(sid)) {
            sessions.delete(sid);
            logger.info("[MCP] Session closed", { sessionId: sid });
          }
        };

        transport.onerror = (err) => {
          logger.error("[MCP] Transport error", { error: err?.message || String(err), userId: auth.userId });
        };

        await server.connect(transport);
        logger.info("[MCP] handleRequest starting", { method: req.method, hasBody: !!req.body, bodyMethod: req.body?.method });
        await transport.handleRequest(req, res, req.body);
      } catch (e) {
        logger.error("[MCP] New session error", { error: e.message });
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal MCP error" },
            id: null,
          });
        }
      }
      return;
    }

    // ── DELETE — close session ──────────────────────────────────────────────
    if (req.method === "DELETE") {
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        session.transport.close?.();
        sessions.delete(sessionId);
        return res.status(200).json({ closed: true });
      }
      return res.status(404).json({ error: "Session not found" });
    }

    // ── Unsupported method ─────────────────────────────────────────────────
    res.status(405).json({ error: "Method not allowed. Use POST, GET, or DELETE." });
  };
}

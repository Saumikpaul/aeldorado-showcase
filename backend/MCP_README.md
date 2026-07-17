# Aeldorado MCP Server

> Connect Claude, Cursor, VS Code and any MCP-compatible AI client to your full Aeldorado account — chat with agents, manage keys, projects, memory, billing and more.

**MCP Endpoint:** `https://api.aeldorado.solanacy.in/mcp`

---

## Quick Start (2 steps)

### Step 1 — Generate an MCP Key

Go to your Aeldorado dashboard → **API Keys** → Generate Key → select scope **`mcp`**.

> ⚠️ Save the key immediately — it is shown only once.

### Step 2 — Connect your AI client

Pick your client below and paste your key + vault password.

---

## Client Configuration

### Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/.claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "aeldorado": {
      "url": "https://api.aeldorado.solanacy.in/mcp",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer aldo-live-your-mcp-key-here",
        "X-Vault-Password": "your-vault-password"
      }
    }
  }
}
```

Restart Claude Desktop — the 🏛️ Aeldorado tools will appear in your tool list.

---

### Claude Code (CLI)

```bash
claude mcp add aeldorado \
  --transport http \
  --header "Authorization: Bearer aldo-live-your-mcp-key-here" \
  --header "X-Vault-Password: your-vault-password" \
  https://api.aeldorado.solanacy.in/mcp
```

Verify it's connected:
```bash
claude mcp list
```

---

### Cursor

Create or edit `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json` for global):

```json
{
  "mcpServers": {
    "aeldorado": {
      "url": "https://api.aeldorado.solanacy.in/mcp",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer aldo-live-your-mcp-key-here",
        "X-Vault-Password": "your-vault-password"
      }
    }
  }
}
```

Or go to **Cursor Settings → Features → MCP Servers → Add**.

---

### VS Code (with MCP extension)

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "aeldorado": {
      "url": "https://api.aeldorado.solanacy.in/mcp",
      "type": "http",
      "headers": {
        "Authorization": "Bearer aldo-live-your-mcp-key-here",
        "X-Vault-Password": "your-vault-password"
      }
    }
  }
}
```

---

## Authentication

The MCP server uses two headers:

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | ✅ Yes | `Bearer aldo-live-xxx` — your MCP-scoped API key |
| `X-Vault-Password` | ✅ For AI calls | Your vault encryption password (needed for `chat`, `call_agent`, `store_vault_key`) |

> **Why vault password?** Aeldorado stores your AI provider keys (Gemini, OpenAI, Anthropic) encrypted with AES-256-GCM. The password decrypts them in-memory on each request — the plaintext key is never stored anywhere.

---

## Available Tools (18)

### 🤖 AI Agents
| Tool | Description |
|------|-------------|
| `chat` | Send a message to the CEO orchestrator — auto-routes to 1-3 specialized agents |
| `call_agent` | Call a specific agent directly: `ceo`, `cfo`, `sales`, `support`, `research`, `marketing`, `legal` |

**Example — Claude asking the Research agent:**
> *"Use call_agent with research to find the top 5 AI API platforms in India"*

---

### 🔑 API Key Management
| Tool | Description |
|------|-------------|
| `list_keys` | List all your API keys (masked) |
| `generate_key` | Generate a new key with chosen scope |
| `revoke_key` | Permanently delete a key by prefix |

---

### 🔐 Vault Management
| Tool | Description |
|------|-------------|
| `list_vault` | See which AI provider keys are stored |
| `store_vault_key` | Encrypt and store a new provider key |
| `remove_vault_key` | Remove a stored provider key |

---

### 📁 Projects
| Tool | Description |
|------|-------------|
| `create_project` | Create a new project |
| `list_projects` | List all projects with memory status |
| `delete_project` | Delete a project and all its memory |

---

### 🧠 Memory
| Tool | Description |
|------|-------------|
| `view_memory` | View all facts stored for a project |
| `remember_fact` | Save a fact to project memory |
| `add_memory` | Add a fact with explicit scope & visibility |
| `delete_memory` | Delete a specific fact from memory |

---

### 📊 Usage, Billing & Logs
| Tool | Description |
|------|-------------|
| `check_usage` | Check daily/weekly/monthly usage and limits |
| `billing_status` | View current tier, subscription status, and plans |
| `view_logs` | Browse recent request logs |

---

## Available Resources (3)

Resources give AI clients read-only context about your account:

| URI | Description |
|-----|-------------|
| `aeldorado://providers` | Supported AI providers and their models |
| `aeldorado://usage` | Current usage statistics |
| `aeldorado://billing` | Subscription tier and limits |

---

## What you can do with this

Once connected, tell your AI assistant (Claude, Cursor, etc.) things like:

- *"Chat with the Aeldorado CFO agent about our Q3 revenue projections"*
- *"List my Aeldorado projects and show memory for the main one"*
- *"Generate a new Aeldorado API key with mcp scope for my new project"*
- *"Check my Aeldorado usage — am I close to the daily limit?"*
- *"Store my OpenAI key in the Aeldorado vault"*
- *"Show my last 20 API request logs from Aeldorado"*
- *"Remember the fact: Our target market is B2B SaaS companies in India"*

---

## How It Works

```
Your AI Client (Claude / Cursor / VS Code)
        │
        │  POST /mcp  (JSON-RPC 2.0 over Streamable HTTP)
        │  Authorization: Bearer aldo-live-xxx
        │  X-Vault-Password: ****
        ▼
api.aeldorado.solanacy.in/mcp
        │
        │  Auth: validates MCP-scoped key in Firestore
        │  Vault: decrypts AI provider key with your password
        ▼
  Aeldorado Internal Functions
  (agents, orchestrator, memory, billing, etc.)
        │
        ▼
  Firestore + AI Providers (Gemini / OpenAI / Anthropic)
```

The MCP server runs **inside** the Aeldorado backend process — it calls internal functions directly (no extra HTTP hops), so latency is minimal.

---

## Security Notes

- Your MCP key requires scope `mcp` — regular `all`/`auto`/`agent:xxx` keys will be rejected
- The vault password is never logged or stored
- Sessions expire after 30 minutes of inactivity
- All traffic is encrypted via HTTPS (TLS 1.2+)
- Rate limits: 30 requests/minute per key (same as regular API keys)

---

## Scope & Limitations

**MCP access is scoped to what's stored in Aeldorado, not your live company infrastructure.**

When you self-host Aeldorado or run agents directly inside your own systems, you control what data agents can see — live databases, internal APIs, real-time feeds, anything you wire up. When you connect via MCP from an external client (Claude Desktop, Cursor, VS Code, etc.), that client only gets what's explicitly available through Aeldorado's own layer:

- **Project memory** (facts you've saved via `remember_fact` / `add_memory`)
- **Account metadata** (keys, usage, billing, logs)
- **Agent responses**, which are grounded in the above — not in your company's live databases, CRMs, or internal tools

This is intentional, not a bug:

- **Security boundary.** Exposing full company infrastructure to any MCP client that holds a valid key would be a large, uncontrolled attack surface. Memory-scoped access lets you control exactly what's exposed.
- **Cost boundary.** Deep, live-data integrations (real-time DB access, custom pipelines) require compute and storage that isn't part of the free tier. Free and paid tiers get project memory; deeper infrastructure hookups are on you to build (self-hosted) or available as a paid integration.

**What this means in practice:** if you ask an agent through MCP a question that depends on live company data you haven't stored as memory, expect a memory-grounded (possibly incomplete) answer — not a live lookup. For full-infrastructure analysis, either:
1. Save the relevant facts into project memory ahead of time, or
2. Run Aeldorado agents inside your own environment with direct access to your data sources.

---

## Troubleshooting

**"Invalid or revoked API key"**
→ Make sure your key has scope `mcp` or `all`. Generate a new one from the dashboard.

**"Vault password not provided"**
→ Add `X-Vault-Password` header to your client config.

**"No API keys in vault"**
→ Use the `store_vault_key` tool or go to Aeldorado dashboard → Vault → add a provider key.

**Tools not appearing in Claude Desktop**
→ Restart Claude Desktop after editing the config file.

**Connection refused**
→ The backend may be waking up (Render free tier). Wait 30s and retry.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-06-28 | Initial MCP server — 18 tools, 3 resources, Streamable HTTP transport |

---

*Built by Solanacy Technologies · [aeldorado.solanacy.in](https://aeldorado.solanacy.in)*

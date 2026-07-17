# Aeldorado — Multi-Agent AI API Platform (Public Showcase)

> ⚠️ **This is a sanitized, public showcase copy of a production codebase.**
> Core proprietary logic — agent system prompts, scoring algorithms, and
> internal business rules — has been redacted (clearly marked
> `[REDACTED — proprietary ... not included in public showcase]`) so the
> **real architecture, code structure, and engineering patterns** are visible
> without exposing the actual IP. The live product runs the full,
> unredacted version.
>
> The **internal admin portal** and the **abuse-detection/user-control
> internals** (`core/anti-abuse.js` — device fingerprinting, IP-sharing
> thresholds, suspension mechanics) are **excluded entirely** from this
> public repo, not just redacted — publishing exact moderation mechanics
> would make them trivial to evade.

Built solo by **Saumik Paul**, Founder of **Solanacy Technologies**.

- 🌐 Live product: [aeldorado.solanacy.in](https://aeldorado.solanacy.in)
- 📡 API: [api.aeldorado.solanacy.in](https://api.aeldorado.solanacy.in)
- 📧 Contact: **aeldorado@solanacy.in**
- 💳 Pricing: **aeldorado.solanacy.in/#pricing**
- 🎥 Demo video: **[embed / link here]**

---

## What is Aeldorado?

Aeldorado is a multi-agent AI API platform — a single API call routes to a
**CEO orchestrator** that dynamically delegates work across six specialized
agents (**CFO, Sales, Support, Research, Marketing, Legal**), then
synthesizes their outputs into one coherent response.

It's built for developers/businesses who want domain-specialist AI behavior
(financial analysis, sales strategy, legal drafting, etc.) without having to
prompt-engineer and orchestrate that themselves.

## Screenshots

> _Add screenshots here — dashboard, API playground, agent responses, admin
> panel, MCP integration page, etc._

`![Dashboard](./screenshots/dashboard.png)`
`![Agent Response](./screenshots/agent-response.png)`

## Architecture

```
                        ┌─────────────────────┐
                        │   Client / API Call  │
                        └──────────┬───────────┘
                                   │
                        ┌──────────▼───────────┐
                        │   CEO Orchestrator     │
                        │  (routing + synthesis) │
                        └──────────┬───────────┘
                 ┌─────────┬───────┼───────┬─────────┬─────────┐
                 ▼         ▼       ▼       ▼         ▼         ▼
               CFO      Sales   Support  Research  Marketing  Legal
                │          │       │        │          │        │
          deterministic  deal   template  live web   content  compliance
           calculators  scoring  drafting  grounded    gen +    drafting +
           (financial-   engine            search +   guardrails disclaimer
            calc.js)   (sales-calc.js)   citations                enforcement
```

**Key engineering patterns:**

- **Deterministic-calculation pre-pass** — LLMs are unreliable at multi-step
  arithmetic (compounding, ratios). The CFO and Sales agents run a narrow
  extraction pass to pull structured numeric params out of free text, then
  compute the real answer in code (`financial-calc.js`, `sales-calc.js`) and
  hand the agent a *verified* number to explain, instead of trusting
  free-text math. This fixed an observed 8x arithmetic error in testing.
- **Grounded live search** — a shared module (`grounded-search.js`) decides
  per-task whether an answer needs current/live information, runs a
  self-hosted search pipeline, and enforces numbered citation rules across
  every agent that needs it (not just Research).
- **Claim verification** — grounded outputs are checked against their cited
  sources before being returned (`claim-verification.js`).
- **Multi-agent orchestration** — the CEO agent routes to 1–3 agents based
  on task complexity, enforces that only the Research agent is trusted for
  live facts (routing Research alongside a domain agent when needed), and
  synthesizes multi-agent results into one response.
- **AES-256-GCM encrypted key vault** — BYOK (bring-your-own-key) support so
  users can plug in their own model provider keys.
- **OAuth 2.0 + PKCE MCP server** — Aeldorado exposes itself as an MCP
  server (`chat`, `call_agent`, `view_logs` tools) so it can be used as a
  connector from Claude and other MCP clients.
- **Full admin portal** *(not included in this public repo)* — user
  management, ban/unban, force-logout, audit logs, broadcast messaging,
  sub-agent latency breakdown per request.

## Tech Stack

- **Backend:** Node.js, Express
- **AI:** Google Gemini (`@google/genai`), MCP SDK (`@modelcontextprotocol/sdk`)
- **Search:** self-hosted metasearch engine + Playwright/Cheerio for live grounding
- **Database:** Firebase / Firestore
- **Payments:** Cashfree
- **Frontend:** vanilla JS/HTML/CSS, deployed on Netlify
- **Security:** AES-256-GCM encryption, OAuth 2.0 + PKCE

## Repo Structure

```
backend/
  agents/          → the 6 specialist agents + CEO orchestrator
    tools/         → structured tool definitions per agent
  core/            → shared infra: auth, billing, encryption, search, calc engines
  middleware/      → request pipeline (auth → billing → abuse-check → decrypt)
  routes/          → REST + MCP route handlers
  scripts/         → cron jobs, migrations
  server.js        → entrypoint
frontend/          → marketing site + docs + API playground
```

> Note: the internal admin portal (separate frontend + `routes/admin.js` +
> `core/admin-auth.js` + `core/anti-abuse.js`) is intentionally not included
> in this public repo — see disclaimer above.

## Running Locally (stub)

This showcase copy has proprietary prompts/algorithms redacted, so it will
**not** produce real agent output out of the box — it's meant for browsing
code structure, not running a full clone of the product. To explore:

```bash
cd backend
cp .env.example .env     # fill in your own Gemini API key + Firebase config
npm install
npm run dev
```

You'll be able to see the request pipeline, routing, and API surface run —
agent responses will reflect the redacted stub prompts rather than the
production ones.

## About the Builder

I'm Saumik Paul, founder of Solanacy Technologies — I designed and built
Aeldorado's full architecture solo (backend, agent orchestration, search
grounding, billing, admin tooling, MCP integration) alongside **D-Dey PMS**,
a pharmacy management system also built by Solanacy.

Open to opportunities — reach out at **[your email]**.

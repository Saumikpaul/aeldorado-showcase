// core/mcp-page.js — Branded landing/guide page for GET /mcp (browser visitors)
// Served only when an unauthenticated browser hits /mcp directly (the
// existing RFC 9728 401 + WWW-Authenticate flow for real MCP clients in
// routes/mcp.js is untouched — see server-side Accept-header gate where
// this is wired in).
//
// Visually matches core/status-page.js / frontend/css/legal.css (light
// liquid-glass system) so the API subdomain stays on-brand. This page is a
// full reference: every tool, resource, scope, and auth rule the MCP
// endpoint actually exposes — kept in sync by hand with routes/mcp.js.

const TOOLS = [
  {
    group: "Chat & Agents",
    items: [
      { name: "chat", desc: "Send a message to the CEO orchestrator. Auto-routes to 1-3 specialist agents (CFO, Sales, Support, Research, Marketing, Legal), runs them in parallel, and synthesizes one answer.", access: "all" },
      { name: "call_agent", desc: "Call one specific agent directly — ceo, cfo, sales, support, research, marketing, or legal.", access: "restricted", note: "Public-facing keys can only call \u201cceo\u201d." },
    ],
  },
  {
    group: "Structured Domain Tools",
    items: [
      { name: "financial_health_checker", desc: "CFO — revenue, expenses, burn rate → financial health check with recommendations.", access: "internal" },
      { name: "pricing_strategy_tool", desc: "CFO — product + market context → pricing model, tiers, and risks.", access: "internal" },
      { name: "invoice_generator", desc: "CFO — client info + line items → clean invoice content.", access: "internal" },
      { name: "cold_outreach_generator", desc: "Sales — prospect + product info → personalized email and LinkedIn message.", access: "internal" },
      { name: "sales_pitch_builder", desc: "Sales — product + audience → slide-by-slide pitch deck content.", access: "internal" },
      { name: "deal_analyzer", desc: "Sales — deal details → win/loss probability and next steps.", access: "internal" },
      { name: "faq_generator", desc: "Support — product info → 20 ready-to-use FAQ pairs.", access: "internal" },
      { name: "customer_response_templates", desc: "Support — situation → empathetic, solution-oriented response template.", access: "internal" },
      { name: "competitor_intelligence_report", desc: "Research — competitor name → strengths, weaknesses, pricing, implications.", access: "internal" },
      { name: "market_size_estimator", desc: "Research — industry + geography → TAM/SAM/SOM breakdown.", access: "internal" },
      { name: "trend_spotter", desc: "Research — topic → emerging trends and concrete opportunities.", access: "internal" },
    ],
  },
  {
    group: "Keys & Vault",
    items: [
      { name: "list_keys", desc: "List your API keys (masked) with scope, project, tier, and last-used date.", access: "all" },
      { name: "generate_key", desc: "Generate a new API key. Shown once. Max 10 active keys per account.", access: "all" },
      { name: "revoke_key", desc: "Permanently revoke a key by its prefix. Cannot be undone.", access: "all" },
      { name: "list_vault", desc: "List provider keys stored in your encrypted vault (masked, no secrets exposed).", access: "all" },
      { name: "store_vault_key", desc: "Store a provider API key in your encrypted vault.", access: "all", note: "Requires an additional vault-auth header." },
      { name: "remove_vault_key", desc: "Remove a provider key from the vault.", access: "all" },
    ],
  },
  {
    group: "Projects & Memory",
    items: [
      { name: "create_project", desc: "Create a project — groups keys under a shared memory pool.", access: "all" },
      { name: "list_projects", desc: "List your projects with memory status and linked key counts.", access: "all" },
      { name: "delete_project", desc: "Delete a project and all its memory. Cannot be undone.", access: "all" },
      { name: "view_memory", desc: "View stored memory facts for a project — scope, visibility, content.", access: "all" },
      { name: "remember_fact", desc: "Save a fact to project memory for future conversations.", access: "all" },
      { name: "add_memory", desc: "Same as remember_fact with explicit scope/visibility control.", access: "all" },
      { name: "delete_memory", desc: "Delete a specific fact from project memory.", access: "all" },
    ],
  },
  {
    group: "Usage & Billing",
    items: [
      { name: "check_usage", desc: "Daily / weekly / monthly usage stats and remaining limits.", access: "all" },
      { name: "billing_status", desc: "Current tier, price, subscription validity, and plan limits.", access: "all" },
      { name: "view_logs", desc: "Recent request logs — agent, model, status, latency.", access: "all" },
    ],
  },
];

const RESOURCES = [
  { uri: "aeldorado://providers", desc: "Supported AI providers and their available models." },
  { uri: "aeldorado://usage", desc: "Current usage statistics and remaining limits." },
  { uri: "aeldorado://billing", desc: "Subscription tier, status, and plan details." },
];

const DO_LIST = [
  "Connect with an API key of scope \u201call\u201d or \u201cmcp\u201d, via Authorization: Bearer or OAuth.",
  "Use call_agent / structured tools for focused, single-domain tasks — cheaper and faster than chat.",
  "Create a project first if you want cross-session memory — link keys to it via project_id.",
  "Store provider keys in the vault once; every tool call reuses them, no raw keys over the wire per-request.",
  "Check check_usage before bulk operations so you don't hit a tier limit mid-task.",
]

const DONT_LIST = [
  "Don't expect call_agent on a public-facing key to reach anything but \u201cceo\u201d — by design, for safety.",
  "Don't send your vault password in chat tools — only store_vault_key reads it, via its dedicated header.",
  "Don't assume memory persists without a project — facts only survive on memory-enabled projects.",
  "Don't poll view_logs in a tight loop — logs are written async and may lag by a few seconds.",
  "Don't reuse a session ID after a server restart — reinitialize; sessions aren't persisted across deploys.",
];

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function accessBadge(access) {
  const map = {
    all: { label: "All keys", bg: "rgba(22,163,74,0.10)", fg: "#16a34a" },
    restricted: { label: "Scope-limited", bg: "rgba(217,119,6,0.10)", fg: "#d97706" },
    internal: { label: "Internal keys only", bg: "rgba(220,38,38,0.10)", fg: "#dc2626" },
  };
  const a = map[access] || map.all;
  return `<span class="mcp-badge" style="background:${a.bg};color:${a.fg};">${a.label}</span>`;
}

export function renderMcpPage({ baseUrl = "https://api.aeldorado.solanacy.in" } = {}) {
  // Public/unauthenticated GET /mcp must not reveal internal-tier tool
  // names or descriptions — drop them here, and drop any group left empty.
  const PUBLIC_TOOLS = TOOLS
    .map((g) => ({ ...g, items: g.items.filter((t) => t.access !== "internal") }))
    .filter((g) => g.items.length > 0);

  const toolGroupsHtml = PUBLIC_TOOLS.map((g) => `
    <div class="mcp-group">
      <div class="mcp-group-title">${escapeHtml(g.group)}</div>
      <div class="mcp-tool-list">
        ${g.items.map((t) => `
          <div class="mcp-tool">
            <div class="mcp-tool-head">
              <code class="mcp-tool-name">${escapeHtml(t.name)}</code>
              ${accessBadge(t.access)}
            </div>
            <div class="mcp-tool-desc">${escapeHtml(t.desc)}</div>
            ${t.note ? `<div class="mcp-tool-note">⚠️ ${escapeHtml(t.note)}</div>` : ""}
          </div>
        `).join("")}
      </div>
    </div>
  `).join("");

  const resourcesHtml = RESOURCES.map((r) => `
    <div class="mcp-resource">
      <code>${escapeHtml(r.uri)}</code>
      <span>${escapeHtml(r.desc)}</span>
    </div>
  `).join("");

  const doHtml = DO_LIST.map((d) => `<li>${escapeHtml(d)}</li>`).join("");
  const dontHtml = DONT_LIST.map((d) => `<li>${escapeHtml(d)}</li>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Aeldorado MCP — Connection Guide</title>
<meta name="robots" content="noindex" />
<link rel="stylesheet" href="https://aeldorado.solanacy.in/css/legal.css" />
<style>
  body { padding-bottom: 80px; }
  .mcp-wrap { max-width: 880px; margin: 0 auto; padding: 120px 24px 0; }

  .mcp-hero {
    display: flex; align-items: flex-start; gap: 16px;
    margin-bottom: 8px;
  }
  .mcp-logo {
    width: 48px; height: 48px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    margin-top: 2px;
  }
  .mcp-logo svg { width: 48px; height: 48px; }
  .mcp-hero-title { font-size: 1.7rem; font-weight: 700; letter-spacing: -0.03em; color: var(--lg-text-1); }
  .mcp-hero-sub { font-size: 0.9rem; color: var(--lg-text-3); }

  .mcp-endpoint-row {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    margin: 22px 0 32px;
    padding: 14px 18px;
    background: var(--lg-card-bg);
    border: 1px solid var(--lg-card-bd);
    border-radius: 14px;
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  }
  .mcp-endpoint-row code {
    font-family: var(--lg-mono); font-size: 0.86rem; color: var(--lg-text-1);
    background: rgba(37,99,235,0.06); padding: 4px 10px; border-radius: 7px;
  }
  .mcp-endpoint-row .mcp-method {
    font-family: var(--lg-mono); font-size: 0.72rem; font-weight: 700;
    color: var(--lg-accent); background: rgba(37,99,235,0.1);
    padding: 3px 8px; border-radius: 6px; letter-spacing: 0.04em;
  }

  .mcp-section { margin-bottom: 36px; }
  .mcp-section-title {
    font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--lg-accent); margin-bottom: 14px;
  }

  .mcp-card {
    background: var(--lg-card-bg);
    border: 1px solid var(--lg-card-bd);
    border-radius: var(--lg-card-r);
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    box-shadow: 0 8px 40px rgba(80,110,200,0.08);
    padding: 26px 28px;
  }

  .mcp-card pre {
    font-family: var(--lg-mono); font-size: 0.82rem; line-height: 1.7;
    color: var(--lg-text-2); white-space: pre-wrap; word-break: break-word;
  }
  .mcp-card pre .k { color: var(--lg-accent); }

  .mcp-group { margin-bottom: 26px; }
  .mcp-group:last-child { margin-bottom: 0; }
  .mcp-group-title {
    font-size: 0.95rem; font-weight: 700; color: var(--lg-text-1);
    margin-bottom: 12px; padding-bottom: 8px;
    border-bottom: 1px solid rgba(37,99,235,0.10);
  }
  .mcp-tool-list { display: flex; flex-direction: column; gap: 10px; }
  .mcp-tool {
    padding: 13px 16px; border-radius: 12px;
    background: rgba(255,255,255,0.55);
    border: 1px solid rgba(37,99,235,0.08);
  }
  .mcp-tool-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
  .mcp-tool-name {
    font-family: var(--lg-mono); font-size: 0.84rem; font-weight: 500;
    color: var(--lg-text-1); background: rgba(37,99,235,0.06);
    padding: 2px 8px; border-radius: 6px;
  }
  .mcp-badge {
    font-size: 0.68rem; font-weight: 700; padding: 3px 9px; border-radius: 999px;
    letter-spacing: 0.02em; white-space: nowrap;
  }
  .mcp-tool-desc { font-size: 0.85rem; color: var(--lg-text-2); line-height: 1.5; }
  .mcp-tool-note { font-size: 0.78rem; color: #d97706; margin-top: 6px; }

  .mcp-resource {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 11px 14px; border-radius: 10px;
    background: rgba(255,255,255,0.55);
    border: 1px solid rgba(37,99,235,0.08);
    margin-bottom: 8px; font-size: 0.85rem;
  }
  .mcp-resource:last-child { margin-bottom: 0; }
  .mcp-resource code {
    font-family: var(--lg-mono); font-size: 0.8rem; color: var(--lg-accent);
    background: rgba(37,99,235,0.06); padding: 2px 8px; border-radius: 6px;
  }
  .mcp-resource span { color: var(--lg-text-2); }

  .mcp-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  @media (max-width: 680px) { .mcp-two-col { grid-template-columns: 1fr; } }

  .mcp-do, .mcp-dont {
    border-radius: var(--lg-card-r);
    padding: 22px 24px;
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  }
  .mcp-do {
    background: rgba(22,163,74,0.06);
    border: 1px solid rgba(22,163,74,0.18);
  }
  .mcp-dont {
    background: rgba(220,38,38,0.05);
    border: 1px solid rgba(220,38,38,0.16);
  }
  .mcp-do-title, .mcp-dont-title {
    font-size: 0.8rem; font-weight: 700; margin-bottom: 12px;
    display: flex; align-items: center; gap: 6px;
  }
  .mcp-do-title { color: #16a34a; }
  .mcp-dont-title { color: #dc2626; }
  .mcp-do ul, .mcp-dont ul { padding-left: 18px; display: flex; flex-direction: column; gap: 8px; }
  .mcp-do li, .mcp-dont li { font-size: 0.83rem; line-height: 1.5; color: var(--lg-text-2); }

  .mcp-footer-links { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; }
  .mcp-footer-links a {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-radius: 12px;
    background: rgba(255,255,255,0.6);
    border: 1px solid rgba(37,99,235,0.10);
    font-size: 0.88rem; font-weight: 500; color: var(--lg-text-1);
    transition: border-color 160ms ease, background 160ms ease;
  }
  .mcp-footer-links a:hover { border-color: rgba(37,99,235,0.32); background: #fff; }
  .mcp-footer-links a span.arrow { color: var(--lg-accent); font-family: var(--lg-mono); }

  .mcp-page-footer {
    text-align: center; margin-top: 40px; font-size: 0.72rem; color: var(--lg-text-3);
  }
</style>
</head>
<body>
  <div class="mcp-wrap">

    <div class="mcp-hero">
      <div class="mcp-logo">
        <svg viewBox="0 0 32 32" fill="none" width="48" height="48">
          <defs>
            <linearGradient id="mg-outer" x1="0" y1="0" x2="32" y2="32">
              <stop stop-color="#3b82f6" offset="0%"/>
              <stop stop-color="#7c3aed" offset="100%"/>
            </linearGradient>
            <linearGradient id="mg-inner" x1="0" y1="0" x2="32" y2="32">
              <stop stop-color="#9ca3af" offset="0%"/>
              <stop stop-color="#4b5563" offset="100%"/>
            </linearGradient>
          </defs>
          <path d="M16 3L3 27h6l7-13 7 13h6L16 3z" fill="url(#mg-outer)"/>
          <path d="M16 16l-3.5 6.5h7L16 16z" fill="url(#mg-inner)"/>
        </svg>
      </div>
      <div>
        <div class="mcp-hero-title">Aeldorado MCP</div>
        <div class="mcp-hero-sub">Model Context Protocol endpoint — connect Claude, Cursor, VS Code, and other MCP clients</div>
      </div>
    </div>

    <div class="mcp-endpoint-row">
      <span class="mcp-method">POST / GET / DELETE</span>
      <code>${escapeHtml(baseUrl)}/mcp</code>
      <span style="font-size:0.78rem;color:var(--lg-text-3);">· Streamable HTTP transport</span>
    </div>

    <div class="mcp-section">
      <div class="mcp-section-title">Tools</div>
      <div class="mcp-card">
        ${toolGroupsHtml}
      </div>
    </div>

    <div class="mcp-section">
      <div class="mcp-section-title">Resources</div>
      <div class="mcp-card">
        ${resourcesHtml}
      </div>
    </div>

    <div class="mcp-section">
      <div class="mcp-section-title">Do &amp; Don't</div>
      <div class="mcp-two-col">
        <div class="mcp-do">
          <div class="mcp-do-title">✅ Do</div>
          <ul>${doHtml}</ul>
        </div>
        <div class="mcp-dont">
          <div class="mcp-dont-title">🚫 Don't</div>
          <ul>${dontHtml}</ul>
        </div>
      </div>
    </div>

    <div class="mcp-section">
      <div class="mcp-section-title">Scope &amp; Limitations</div>
      <div class="mcp-card">
        <p style="font-size:0.85rem;line-height:1.6;color:var(--lg-text-2);margin:0 0 12px;">
          MCP access is scoped to what's stored in Aeldorado — <strong>project memory and account
          data</strong> — not your live company infrastructure. Agent answers are grounded in saved
          memory, not real-time databases, CRMs, or internal tools, even if you self-host Aeldorado
          elsewhere with deeper access.
        </p>
        <p style="font-size:0.85rem;line-height:1.6;color:var(--lg-text-2);margin:0;">
          This is a deliberate boundary: unrestricted infrastructure access for any client holding a
          valid key would be a large attack surface, and live-data integrations carry compute costs
          outside the free tier. Save relevant facts to project memory ahead of time, or run agents
          inside your own environment for full-infrastructure analysis.
        </p>
      </div>
    </div>

    <div class="mcp-section">
      <div class="mcp-section-title">More</div>
      <div class="mcp-footer-links">
        <a href="https://aeldorado.solanacy.in/docs.html">Full API Documentation <span class="arrow">→</span></a>
        <a href="${escapeHtml(baseUrl)}">API Status <span class="arrow">→</span></a>
        <a href="https://aeldorado.solanacy.in">Dashboard <span class="arrow">→</span></a>
        <a href="https://aeldorado.solanacy.in/contact.html">Contact / Support <span class="arrow">→</span></a>
      </div>
    </div>

    <div class="mcp-page-footer">Aeldorado · by Solanacy Technologies · MCP base <code>${escapeHtml(baseUrl)}/mcp</code></div>
  </div>
</body>
</html>`;
}

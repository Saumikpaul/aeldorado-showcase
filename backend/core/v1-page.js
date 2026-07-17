// core/v1-page.js — Branded landing/reference page for GET /v1 (browser visitors)
// API clients still get the raw JSON payload from server.js — see the
// Accept-header negotiation there. Visually matches core/status-page.js and
// core/mcp-page.js (light liquid-glass system) so the whole API subdomain
// stays on-brand. Kept in sync by hand with the /v1 route table in server.js.

const ENDPOINT_GROUPS = [
  {
    group: "Chat & Agents",
    items: [
      { method: "POST", path: "/v1/chat", desc: "Auto-routing chat — the CEO orchestrator picks 1-3 specialist agents, runs them in parallel, and synthesizes one answer." },
      { method: "POST", path: "/v1/agent/:name", desc: "Direct call to one specific agent — ceo, cfo, sales, support, research, marketing, or legal." },
    ],
  },
  {
    group: "Keys & Usage",
    items: [
      { method: "POST", path: "/v1/keys/generate", desc: "Generate a new API key. Shown once." },
      { method: "POST", path: "/v1/keys/revoke", desc: "Permanently revoke a key. Cannot be undone." },
      { method: "GET", path: "/v1/usage", desc: "Check current usage and remaining limits." },
      { method: "GET", path: "/v1/providers", desc: "List supported AI providers and their models." },
    ],
  },
  {
    group: "Projects & Memory",
    items: [
      { method: "POST", path: "/v1/projects/create", desc: "Create a project — groups keys under a shared memory pool." },
      { method: "GET", path: "/v1/projects/list", desc: "List your projects." },
      { method: "GET", path: "/v1/projects/:projectId", desc: "Get project details." },
      { method: "POST", path: "/v1/projects/update", desc: "Rename a project." },
      { method: "DELETE", path: "/v1/projects/delete", desc: "Delete a project and all its memory." },
      { method: "POST", path: "/v1/projects/memory/toggle", desc: "Enable or disable project memory." },
      { method: "DELETE", path: "/v1/projects/memory/clear", desc: "Wipe project memory." },
      { method: "POST", path: "/v1/memory/remember", desc: "Manually save a fact (API key auth)." },
      { method: "GET", path: "/v1/memory/:projectId", desc: "Inspect project memory (dashboard)." },
    ],
  },
  {
    group: "Account & Dashboard",
    items: [
      { method: "POST", path: "/v1/user/register", desc: "Register or sync a user." },
      { method: "PUT", path: "/v1/user/ip-allowlist", desc: "Update IP allowlist." },
      { method: "GET", path: "/v1/logs", desc: "Request logs (dashboard)." },
      { method: "GET", path: "/v1/analytics", desc: "Usage analytics (dashboard)." },
    ],
  },
];

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function methodBadge(method) {
  const map = {
    GET: { bg: "rgba(22,163,74,0.10)", fg: "#16a34a" },
    POST: { bg: "rgba(37,99,235,0.10)", fg: "#2563eb" },
    PUT: { bg: "rgba(217,119,6,0.10)", fg: "#d97706" },
    DELETE: { bg: "rgba(220,38,38,0.10)", fg: "#dc2626" },
  };
  const m = map[method] || map.GET;
  return `<span class="v1-method" style="background:${m.bg};color:${m.fg};">${method}</span>`;
}

export function renderV1Page({ baseUrl = "https://api.aeldorado.solanacy.in" } = {}) {
  const groupsHtml = ENDPOINT_GROUPS.map((g) => `
    <div class="v1-group">
      <div class="v1-group-title">${escapeHtml(g.group)}</div>
      <div class="v1-endpoint-list">
        ${g.items.map((e) => `
          <div class="v1-endpoint">
            ${methodBadge(e.method)}
            <code class="v1-path">${escapeHtml(e.path)}</code>
            <span class="v1-desc">${escapeHtml(e.desc)}</span>
          </div>
        `).join("")}
      </div>
    </div>
  `).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Aeldorado API — v1 Reference</title>
<meta name="robots" content="noindex" />
<link rel="stylesheet" href="https://aeldorado.solanacy.in/css/legal.css" />
<style>
  body { padding-bottom: 80px; }
  .v1-wrap { max-width: 880px; margin: 0 auto; padding: 120px 24px 0; }

  .v1-hero {
    display: flex; align-items: flex-start; gap: 16px;
    margin-bottom: 8px;
  }
  .v1-logo {
    width: 48px; height: 48px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    margin-top: 2px;
  }
  .v1-logo svg { width: 48px; height: 48px; }
  .v1-hero-title { font-size: 1.7rem; font-weight: 700; letter-spacing: -0.03em; color: var(--lg-text-1); }
  .v1-hero-sub { font-size: 0.9rem; color: var(--lg-text-3); }

  .v1-endpoint-row {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    margin: 22px 0 32px;
    padding: 14px 18px;
    background: var(--lg-card-bg);
    border: 1px solid var(--lg-card-bd);
    border-radius: 14px;
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  }
  .v1-endpoint-row code {
    font-family: var(--lg-mono); font-size: 0.86rem; color: var(--lg-text-1);
    background: rgba(37,99,235,0.06); padding: 4px 10px; border-radius: 7px;
  }

  .v1-section { margin-bottom: 36px; }
  .v1-section-title {
    font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--lg-accent); margin-bottom: 14px;
  }

  .v1-card {
    background: var(--lg-card-bg);
    border: 1px solid var(--lg-card-bd);
    border-radius: var(--lg-card-r);
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    box-shadow: 0 8px 40px rgba(80,110,200,0.08);
    padding: 26px 28px;
  }

  .v1-group { margin-bottom: 26px; }
  .v1-group:last-child { margin-bottom: 0; }
  .v1-group-title {
    font-size: 0.95rem; font-weight: 700; color: var(--lg-text-1);
    margin-bottom: 12px; padding-bottom: 8px;
    border-bottom: 1px solid rgba(37,99,235,0.10);
  }
  .v1-endpoint-list { display: flex; flex-direction: column; gap: 9px; }
  .v1-endpoint {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 11px 14px; border-radius: 10px;
    background: rgba(255,255,255,0.55);
    border: 1px solid rgba(37,99,235,0.08);
  }
  .v1-method {
    font-family: var(--lg-mono); font-size: 0.68rem; font-weight: 700;
    padding: 3px 8px; border-radius: 6px; letter-spacing: 0.03em;
    min-width: 50px; text-align: center;
  }
  .v1-path {
    font-family: var(--lg-mono); font-size: 0.82rem; font-weight: 500;
    color: var(--lg-text-1); background: rgba(37,99,235,0.06);
    padding: 2px 8px; border-radius: 6px;
  }
  .v1-desc { font-size: 0.83rem; color: var(--lg-text-2); flex: 1 1 220px; }

  .v1-chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .v1-chip {
    font-size: 0.82rem; font-weight: 500; color: var(--lg-text-1);
    background: rgba(255,255,255,0.6);
    border: 1px solid rgba(37,99,235,0.10);
    padding: 7px 14px; border-radius: 999px;
  }

  .v1-tiers { display: flex; flex-direction: column; gap: 8px; }
  .v1-tier {
    display: flex; align-items: center; justify-content: space-between;
    padding: 11px 14px; border-radius: 10px;
    background: rgba(255,255,255,0.55);
    border: 1px solid rgba(37,99,235,0.08);
    font-size: 0.86rem;
  }
  .v1-tier-name { font-weight: 600; color: var(--lg-text-1); }
  .v1-tier-price { font-family: var(--lg-mono); color: var(--lg-accent); font-weight: 600; }

  .v1-footer-links { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; }
  .v1-footer-links a {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-radius: 12px;
    background: rgba(255,255,255,0.6);
    border: 1px solid rgba(37,99,235,0.10);
    font-size: 0.88rem; font-weight: 500; color: var(--lg-text-1);
    transition: border-color 160ms ease, background 160ms ease;
  }
  .v1-footer-links a:hover { border-color: rgba(37,99,235,0.32); background: #fff; }
  .v1-footer-links a span.arrow { color: var(--lg-accent); font-family: var(--lg-mono); }

  .v1-page-footer {
    text-align: center; margin-top: 40px; font-size: 0.72rem; color: var(--lg-text-3);
  }
</style>
</head>
<body>
  <div class="v1-wrap">

    <div class="v1-hero">
      <div class="v1-logo">
        <svg viewBox="0 0 32 32" fill="none" width="48" height="48">
          <defs>
            <linearGradient id="vg-outer" x1="0" y1="0" x2="32" y2="32">
              <stop stop-color="#3b82f6" offset="0%"/>
              <stop stop-color="#7c3aed" offset="100%"/>
            </linearGradient>
            <linearGradient id="vg-inner" x1="0" y1="0" x2="32" y2="32">
              <stop stop-color="#9ca3af" offset="0%"/>
              <stop stop-color="#4b5563" offset="100%"/>
            </linearGradient>
          </defs>
          <path d="M16 3L3 27h6l7-13 7 13h6L16 3z" fill="url(#vg-outer)"/>
          <path d="M16 16l-3.5 6.5h7L16 16z" fill="url(#vg-inner)"/>
        </svg>
      </div>
      <div>
        <div class="v1-hero-title">Aeldorado API v1</div>
        <div class="v1-hero-sub">REST endpoints for chat, agents, keys, projects, and usage — auth with an API key or OAuth token</div>
      </div>
    </div>

    <div class="v1-endpoint-row">
      <code>${escapeHtml(baseUrl)}/v1</code>
      <span style="font-size:0.78rem;color:var(--lg-text-3);">· JSON over HTTPS · Bearer auth</span>
    </div>

    <div class="v1-section">
      <div class="v1-section-title">Endpoints</div>
      <div class="v1-card">
        ${groupsHtml}
      </div>
    </div>

    <div class="v1-section">
      <div class="v1-section-title">More</div>
      <div class="v1-footer-links">
        <a href="https://aeldorado.solanacy.in/docs.html">Full API Documentation <span class="arrow">→</span></a>
        <a href="${escapeHtml(baseUrl)}/mcp">MCP Connection Guide <span class="arrow">→</span></a>
        <a href="${escapeHtml(baseUrl)}">API Status <span class="arrow">→</span></a>
        <a href="https://aeldorado.solanacy.in/contact.html">Contact / Support <span class="arrow">→</span></a>
      </div>
    </div>

    <div class="v1-page-footer">Aeldorado · by Solanacy Technologies · API base <code>${escapeHtml(baseUrl)}/v1</code></div>
  </div>
</body>
</html>`;
}

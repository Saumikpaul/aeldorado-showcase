// core/status-page.js — Branded root landing page for api.aeldorado.solanacy.in
// Served to browser visitors who hit the API root directly. API clients
// (curl, SDKs, fetch with Accept: application/json) still get the raw
// JSON payload from server.js — see the Accept-header negotiation there.
//
// Visually matches frontend/css/legal.css (the same light liquid-glass
// system used on docs.html, privacy.html, terms.html, contact.html) so the
// API subdomain doesn't feel disconnected from the rest of the brand.

const STATUS_COPY = {
  operational: { label: "All systems operational", dot: "#16a34a", glow: "rgba(22,163,74,0.16)" },
  degraded:    { label: "Degraded performance",      dot: "#d97706", glow: "rgba(217,119,6,0.16)" },
  down:        { label: "Service disruption",        dot: "#dc2626", glow: "rgba(220,38,38,0.16)" },
};

export function renderStatusPage({ status = "operational", version = "1.0.0", dbLatencyMs = null, lastChecked = new Date() } = {}) {
  const s = STATUS_COPY[status] || STATUS_COPY.operational;
  const latencyLine = dbLatencyMs != null
    ? `<span class="status-meta">· Response time ${dbLatencyMs}ms</span>`
    : "";
  const checkedTime = new Date(lastChecked).toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata",
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Aeldorado API — Status</title>
<meta name="robots" content="noindex" />
<link rel="stylesheet" href="https://aeldorado.solanacy.in/css/legal.css" />
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 24px;
    background:
      radial-gradient(680px circle at 18% 14%, rgba(124,58,237,0.16), transparent 60%),
      radial-gradient(620px circle at 86% 82%, rgba(59,130,246,0.16), transparent 60%),
      var(--lg-bg, #f4f6fb);
    background-attachment: fixed;
    overflow: hidden;
    position: relative;
  }
  body::before {
    content: "";
    position: fixed; inset: -10%;
    background:
      radial-gradient(420px circle at 10% 85%, rgba(99,102,241,0.10), transparent 65%),
      radial-gradient(380px circle at 92% 8%, rgba(59,130,246,0.10), transparent 65%);
    animation: drift 16s ease-in-out infinite alternate;
    pointer-events: none; z-index: 0;
  }
  @keyframes drift {
    0%   { transform: translate(0, 0) scale(1); }
    100% { transform: translate(2%, -2%) scale(1.04); }
  }
  .status-card {
    position: relative; z-index: 1;
    max-width: 460px; width: 100%;
    background: var(--lg-card-bg);
    border: 1px solid var(--lg-card-bd);
    border-radius: var(--lg-card-r);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    box-shadow: 0 1px 1px rgba(80,110,200,0.04), 0 24px 60px -12px rgba(60,80,180,0.18);
    padding: 44px 36px 36px;
    text-align: center;
    animation: rise 480ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(10px) scale(0.985); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  .status-logo {
    width: 52px; height: 52px; margin: 0 auto 20px;
    display: flex; align-items: center; justify-content: center;
    position: relative;
    filter: drop-shadow(0 8px 26px rgba(59,130,246,0.55)) drop-shadow(0 2px 8px rgba(124,58,237,0.35));
    animation: float 5s ease-in-out infinite;
  }
  .status-logo svg { width: 52px; height: 52px; }
  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50%      { transform: translateY(-4px); }
  }
  .status-name {
    font-size: 1.5rem; font-weight: 800; letter-spacing: -0.035em;
    color: var(--lg-text-1); margin-bottom: 6px;
    background: linear-gradient(135deg, var(--lg-text-1) 30%, #3b82f6 100%);
    -webkit-background-clip: text; background-clip: text;
  }
  .status-tagline {
    font-size: 0.85rem; color: var(--lg-text-3); margin-bottom: 26px;
  }
  .status-pill {
    display: inline-flex; align-items: center; gap: 9px;
    padding: 8px 18px; border-radius: 999px;
    background: ${s.glow};
    border: 1px solid ${s.dot}33;
    font-size: 0.82rem; font-weight: 600; color: var(--lg-text-1);
    margin-bottom: 30px;
  }
  .status-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: ${s.dot};
    box-shadow: 0 0 0 4px ${s.glow};
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 4px ${s.glow}; }
    50%      { box-shadow: 0 0 0 7px ${s.glow}; }
  }
  .status-meta { color: var(--lg-text-3); font-weight: 500; font-size: 0.78rem; }
  .status-checked {
    font-size: 0.74rem; color: var(--lg-text-3); margin: -18px 0 24px;
    font-family: var(--lg-mono);
  }
  .status-links {
    display: flex; flex-direction: column; gap: 10px;
  }
  .status-links a {
    display: flex; align-items: center; justify-content: space-between;
    padding: 13px 18px; border-radius: 12px;
    background: rgba(255,255,255,0.6);
    border: 1px solid rgba(37,99,235,0.10);
    font-size: 0.88rem; font-weight: 500; color: var(--lg-text-1);
    transition: border-color 160ms ease, background 160ms ease, transform 160ms ease, box-shadow 160ms ease;
  }
  .status-links a:hover {
    border-color: rgba(37,99,235,0.32); background: #fff; color: var(--lg-text-1);
    transform: translateY(-1px);
    box-shadow: 0 8px 20px -8px rgba(37,99,235,0.25);
  }
  .status-links a:hover span.arrow { transform: translateX(3px); }
  .status-links a span.arrow {
    color: var(--lg-accent); font-family: var(--lg-mono);
    transition: transform 160ms ease;
  }
  .status-footer {
    margin-top: 28px; font-size: 0.72rem; color: var(--lg-text-3);
  }
  .status-footer code {
    font-family: var(--lg-mono); background: rgba(37,99,235,0.06);
    padding: 2px 6px; border-radius: 5px; font-size: 0.7rem;
  }
</style>
</head>
<body>
  <div class="status-card">
    <div class="status-logo">
      <svg viewBox="0 0 32 32" fill="none" width="44" height="44">
        <defs>
          <linearGradient id="sg-outer" x1="0" y1="0" x2="32" y2="32">
            <stop stop-color="#3b82f6" offset="0%"/>
            <stop stop-color="#7c3aed" offset="100%"/>
          </linearGradient>
          <linearGradient id="sg-inner" x1="0" y1="0" x2="32" y2="32">
            <stop stop-color="#9ca3af" offset="0%"/>
            <stop stop-color="#4b5563" offset="100%"/>
          </linearGradient>
        </defs>
        <path d="M16 3L3 27h6l7-13 7 13h6L16 3z" fill="url(#sg-outer)"/>
        <path d="M16 16l-3.5 6.5h7L16 16z" fill="url(#sg-inner)"/>
      </svg>
    </div>
    <div class="status-name">Aeldorado</div>
    <div class="status-tagline">The Legendary Intelligence — by Solanacy Technologies</div>

    <div class="status-pill">
      <span class="status-dot"></span>
      ${s.label}
      ${latencyLine}
    </div>

    <div class="status-checked">Last checked ${checkedTime} IST</div>

    <div class="status-links">
      <a href="https://aeldorado.solanacy.in/docs.html">
        Documentation <span class="arrow">→</span>
      </a>
      <a href="https://aeldorado.solanacy.in">
        Dashboard <span class="arrow">→</span>
      </a>
      <a href="https://aeldorado.solanacy.in/contact.html">
        Contact / Support <span class="arrow">→</span>
      </a>
    </div>

    <div class="status-footer">v${version} · API base <code>/v1</code> · MCP at <code>/mcp</code></div>
  </div>
</body>
</html>`;
}

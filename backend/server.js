// server.js — Aeldorado API Server
// "The Legendary Intelligence" by Solanacy Technologies
//
// Public AI API Platform — multi-agent routing, E2E encrypted key vault,
// prepaid billing, anti-abuse protection.

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

import { chatRouter }    from "./routes/chat.js";
import { agentsRouter }  from "./routes/agents.js";
import { keysRouter }    from "./routes/keys.js";
import { usageRouter }   from "./routes/usage.js";
import { vaultRouter }   from "./routes/vault.js";
import { logsRouter }    from "./routes/logs.js";
import { userRouter }    from "./routes/user.js";
import { projectsRouter } from "./routes/projects.js";
import { memoryRouter }   from "./routes/memory.js";
import { billingRouter } from "./routes/billing.js";
import { createMcpHandler } from "./routes/mcp.js";
import { createOAuthRouter } from "./routes/oauth.js";
import { mcpVaultRouter } from "./routes/mcpVault.js";
import { newsRouter } from "./routes/news.js";
import { listProviders } from "./core/provider-detect.js";
import { TIER_LIMITS, checkSubscriptionValid } from "./core/billing.js";
import { ensureUser, getUserDoc }    from "./core/user-manager.js";
import { renderStatusPage } from "./core/status-page.js";
import { renderV1Page } from "./core/v1-page.js";
import { logger }        from "./core/logger.js";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.set("trust proxy", 1); // Trust Render's reverse proxy (fixes X-Forwarded-For rate limit error)

// Render automatically sets RENDER=true — use it as fallback if NODE_ENV not set
const IS_PROD = process.env.NODE_ENV === "production" || !!process.env.RENDER;

// ── CORS Configs ─────────────────────────────────────────────────────────────
const ADMIN_ORIGINS = IS_PROD
  ? [
      "https://aeldorado.solanacy.in",
      "https://www.aeldorado.solanacy.in",
      "https://admin.aeldorado.solanacy.in",
    ]
  : [
      "https://aeldorado.solanacy.in",
      "https://admin.aeldorado.solanacy.in",
      "http://localhost:3000",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "http://127.0.0.1:8080",
    ];

// Public API — for developers integrating Aeldorado into their apps
const publicCors = cors({
  origin: "*",
});

// Admin/Dashboard — strict security, only our domains
const adminCors = cors({
  origin: (origin, callback) => {
    if (!origin || ADMIN_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      // Instead of throwing an error (which causes a 500 crash), return false
      // to let the browser gracefully block it as a standard CORS error.
      callback(null, false);
    }
  },
  credentials: true,
});

// ── Security ─────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ── Body parsing — express.json with raw body capture for webhook ─────────────
// The verify callback captures the raw buffer for /v1/billing/webhook
// so we can verify Cashfree HMAC signatures without consuming the stream twice.
app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buf) => {
    if (req.path === "/v1/billing/webhook") {
      req.rawBody = buf.toString("utf8");
    }
  },
}));

// ── Branding Header ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("X-Powered-By", "Aeldorado by Solanacy");
  next();
});

// ── Global Rate Limiter (per IP) ─────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,    // 1 minute
  max:      120,           // 120 requests per minute per IP
  standardHeaders: true,
  legacyHeaders:   false,
  message: {
    error: {
      code:    "rate_limit_exceeded",
      message: "Too many requests. Please slow down.",
    },
    meta: { powered_by: "Aeldorado by Solanacy" },
  },
});
app.use("/v1/", globalLimiter);

// ── Firebase Admin Init ──────────────────────────────────────────────────────
let db, adminAuth;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
  db        = getFirestore(undefined, process.env.FIRESTORE_DATABASE_ID || "your-project-id"); // [REDACTED — internal infra ID not included in public showcase]
  adminAuth = getAuth();
  logger.info("Firebase Admin initialized", { databaseId: process.env.FIRESTORE_DATABASE_ID || "your-project-id" });
} catch (e) {
  logger.error("Firebase Admin init failed", { error: e.message });
  process.exit(1);
}

// ── Inject dependencies into request ─────────────────────────────────────────
app.use((req, res, next) => {
  req.db        = db;
  req.adminAuth = adminAuth;
  next();
});

// ── Firebase Auth Middleware (for dashboard routes) ──────────────────────────
async function dashboardAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: { code: "auth_required", message: "Authorization header required." } });
  }
  try {
    const token   = authHeader.split(" ")[1];
    const decoded = await adminAuth.verifyIdToken(token);
    req.userId       = decoded.uid;
    req.decodedToken = decoded;

    // Auto-register user on first authenticated request
    const userData = await ensureUser(db, decoded);
    req.userData   = userData;

    next();
  } catch (e) {
    return res.status(401).json({ error: { code: "invalid_token", message: "Invalid or expired auth token." } });
  }
}

// ── OPTIONS Preflight Handler ────────────────────────────────────────────────
// Must be before routes to properly handle browser preflight checks
app.options("/v1/chat",            publicCors);
app.options("/v1/agent/*",         publicCors);
app.options("/v1/usage",           publicCors);

app.options("/v1/keys/*",          adminCors);
app.options("/v1/vault/*",         adminCors);
app.options("/v1/logs",            adminCors);
app.options("/v1/analytics",       adminCors);
app.options("/v1/user/*",          adminCors);
app.options("/v1/projects/*",      adminCors);
app.options("/v1/memory/*",        publicCors);
app.options("/v1/providers",       publicCors);
app.options("/v1/billing/webhook", cors({ origin: "*" })); // Cashfree webhook
app.options("/v1/billing/*",       adminCors);
app.options("/v1/mcp-vault/*",     adminCors);

// MCP endpoint — public CORS (AI clients connect from anywhere)
app.options("/mcp",               publicCors);

// OAuth endpoints — public CORS (MCP clients connect from anywhere)
app.options("/oauth/*",           publicCors);
app.options("/.well-known/*",     publicCors);

// ── Firebase Auth Proxy ───────────────────────────────────────────────────────
// Firebase signInWithRedirect needs /__/auth/ to exist on the same origin as
// the auth page (api.aeldorado.solanacy.in). Proxy to Firebase Hosting.
app.use("/__/auth", (req, res) => {
  // [REDACTED — internal Firebase project domain not included in public showcase]
  const FIREBASE_PROJECT_DOMAIN = process.env.FIREBASE_PROJECT_DOMAIN || "your-project.firebaseapp.com";
  const target = `https://${FIREBASE_PROJECT_DOMAIN}/__/auth${req.url}`;
  const opts = {
    method: req.method,
    headers: { ...req.headers, host: FIREBASE_PROJECT_DOMAIN },
  };
  const proxyReq = https.request(target, opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxyReq.on("error", (e) => res.status(502).send("Auth proxy error: " + e.message));
  req.pipe(proxyReq, { end: true });
});

// ── Favicon (same Aeldorado "A" logo used on the frontend) ────────────────────
// Serves this on the API subdomain too, since MCP clients and browsers look
// here first — without this, they were falling back to the parent domain's
// (solanacy.in) logo instead of Aeldorado's own branding.
app.get("/favicon.ico", publicCors, (req, res) => {
  res.sendFile(path.join(__dirname, "assets", "aeldorado.png"));
});
app.get("/favicon.png", publicCors, (req, res) => {
  res.sendFile(path.join(__dirname, "assets", "aeldorado.png"));
});

// ── Health & Info ────────────────────────────────────────────────────────────
app.get("/", adminCors, async (req, res) => {
  // Decide status by pinging Firestore with a tight timeout. The server
  // already exits at boot if Firestore init fails entirely, so this only
  // ever distinguishes "operational" vs "degraded" (slow/flaky), not "down".
  let status = "operational";
  let dbLatencyMs = null;
  try {
    const start = Date.now();
    await Promise.race([
      db.collection("_health").limit(1).get(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2500)),
    ]);
    dbLatencyMs = Date.now() - start;
    if (dbLatencyMs > 1200) status = "degraded";
  } catch (e) {
    status = "degraded";
    logger.warn("[Status] DB health check failed", { error: e.message });
  }

  const payload = {
    name:        "Aeldorado",
    tagline:     "The Legendary Intelligence",
    by:          "Solanacy Technologies",
    version:     "1.0.0",
    status,
    docs:        "https://aeldorado.solanacy.in/docs",
    api_base:    "https://api.aeldorado.solanacy.in/v1",
  };

  // Browsers send "Accept: text/html,..." first; API clients (curl, SDKs,
  // fetch with no override) typically prefer JSON or send */*. req.accepts
  // picks whichever the client listed first/preferred.
  const wantsHtml = req.accepts(["html", "json"]) === "html";
  if (wantsHtml) {
    res.set("Content-Type", "text/html").send(renderStatusPage({ status, version: payload.version, dbLatencyMs, lastChecked: new Date() }));
  } else {
    res.json(payload);
  }
});

app.get("/v1", adminCors, (req, res) => {
  const wantsHtml = req.accepts(["html", "json"]) === "html";
  if (wantsHtml) {
    return res.set("Content-Type", "text/html").send(renderV1Page({
      baseUrl: "https://api.aeldorado.solanacy.in",
    }));
  }

  const agents = ["ceo", "cfo", "sales", "support", "research", "marketing", "legal"];
  const tiers = Object.entries(TIER_LIMITS).map(([id, t]) => ({ id, name: t.name, price: t.price }));

  res.json({
    version:   "v1",
    endpoints: [
      { method: "POST", path: "/v1/chat",                     description: "Auto-routing chat (CEO orchestrator)" },
      { method: "POST", path: "/v1/agent/:name",               description: "Direct agent call" },
      { method: "GET",  path: "/v1/usage",                     description: "Check usage & limits" },
      { method: "POST", path: "/v1/keys/generate",             description: "Generate API key" },
      { method: "POST", path: "/v1/keys/revoke",               description: "Revoke API key" },
      { method: "GET",  path: "/v1/providers",                 description: "List supported AI providers" },
      { method: "GET",  path: "/v1/logs",                      description: "Request logs (dashboard)" },
      { method: "GET",  path: "/v1/analytics",                 description: "Usage analytics (dashboard)" },
      { method: "POST", path: "/v1/user/register",             description: "Register/sync user" },
      { method: "PUT",  path: "/v1/user/ip-allowlist",         description: "Update IP allowlist" },
      { method: "POST", path: "/v1/projects/create",           description: "Create a project" },
      { method: "GET",  path: "/v1/projects/list",             description: "List projects" },
      { method: "GET",  path: "/v1/projects/:projectId",       description: "Get project details" },
      { method: "POST", path: "/v1/projects/update",           description: "Rename project" },
      { method: "DELETE",path: "/v1/projects/delete",          description: "Delete project" },
      { method: "POST", path: "/v1/projects/memory/toggle",    description: "Enable/disable project memory" },
      { method: "DELETE",path: "/v1/projects/memory/clear",    description: "Wipe project memory" },
      { method: "POST", path: "/v1/memory/remember",           description: "Manually save a fact (API key auth)" },
      { method: "GET",  path: "/v1/memory/:projectId",         description: "Inspect project memory (dashboard)" },
      { method: "ALL",  path: "/mcp",                          description: "MCP (Model Context Protocol) — connect Claude, Cursor, etc." },
    ],
    mcp_endpoint: "https://api.aeldorado.solanacy.in/mcp",
    agents,
    tiers,
    meta:      { powered_by: "Aeldorado by Solanacy" },
  });
});

// ── Provider info endpoint ───────────────────────────────────────────────────
app.get("/v1/providers", publicCors, (req, res) => {
  res.json({
    providers: listProviders(),
    meta: { powered_by: "Aeldorado by Solanacy" },
  });
});

// ── Mount Route Modules ──────────────────────────────────────────────────────
// ── PUBLIC routes (origin: * — users call kore) ───────────────
app.use("/v1", publicCors, chatRouter);
app.use("/v1", publicCors, agentsRouter);
app.use("/v1", publicCors, usageRouter);
app.use("/v1", publicCors, newsRouter);

// ── ADMIN routes (only aeldorado.solanacy.in) ─────────────────
app.use("/v1/keys",  adminCors, keysRouter);
app.use("/v1/vault", adminCors, vaultRouter);
app.use("/v1", adminCors, dashboardAuth, logsRouter);
app.use("/v1", adminCors, dashboardAuth, userRouter);
app.use("/v1/projects", adminCors, projectsRouter);

// ── Billing routes ─────────────────────────────────────────────
// Webhook: public CORS (Cashfree calls it, no browser CORS needed)
// Other billing: adminCors + dashboardAuth
app.post("/v1/billing/webhook", cors({ origin: "*" }), billingRouter);
app.use("/v1", adminCors, dashboardAuth, billingRouter);

// ── Admin routes intentionally not included in this public showcase ───────
// (internal moderation/user-control endpoints — see README)

app.use("/v1", adminCors, dashboardAuth, (req, res, next) => {
  req.db = db;
  next();
}, mcpVaultRouter);

// ── Public memory endpoint (API-key auth) + Admin memory inspect ──────────────
app.use("/v1/memory", publicCors, memoryRouter);

// ── MCP (Model Context Protocol) endpoint ─────────────────────────────────────
// Streamable HTTP transport for Claude Desktop, Claude Code, Cursor, etc.
// URL: https://api.aeldorado.solanacy.in/mcp
const mcpHandler = createMcpHandler(db, adminAuth);
app.all("/mcp", publicCors, mcpHandler);

// ── OAuth 2.0 endpoints (lets MCP clients connect without a raw API key) ─────
app.use(publicCors, createOAuthRouter(db, adminAuth));

// ── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: {
      code:    "not_found",
      message: `Route ${req.method} ${req.path} does not exist.`,
    },
    meta: { powered_by: "Aeldorado by Solanacy" },
  });
});

// ── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error("Global Error Handler", { error: err.message, stack: err.stack, path: req.path });
  res.status(500).json({
    error: {
      code:    "internal_error",
      message: "An unexpected server error occurred.",
    },
    meta: { powered_by: "Aeldorado by Solanacy" },
  });
});



// ── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║  🏛️  AELDORADO — The Legendary Intelligence  ║`);
  console.log(`  ║     by Solanacy Technologies              ║`);
  console.log(`  ║     Running on port ${PORT}                    ║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);

  // ── Self-Ping (keeps Render free tier alive) ─────────────────────────────
  const PING_URL = process.env.PING_URL || "https://api.aeldorado.solanacy.in";
  // Also keep our self-hosted metasearch instance warm on the same
  // interval — otherwise Render's free tier spins it down when idle, and
  // the first live-search request after a spin-down times out waiting for
  // cold start (confirmed in production logs: "Meta-search fetch failed...
  // Timeout" followed by a fallback all the way down to direct Google/
  // DuckDuckGo scraping). Pinging its own /healthz keeps it warm without
  // consuming a real search-engine query every 5 minutes.
  const META_SEARCH_PING_URL = `${process.env.META_SEARCH_BASE_URL || "https://your-meta-search-instance.example.com"}/healthz`; // [REDACTED — internal infra URL not included in public showcase]
  const PING_INTERVAL = 5 * 60 * 1000; // 5 minutes

  if (IS_PROD) {
    setInterval(async () => {
      try {
        const res = await fetch(PING_URL);
        console.log(`[PING] ${new Date().toISOString()} → ${res.status} OK`);
      } catch (e) {
        console.error(`[PING] ${new Date().toISOString()} → FAIL: ${e.message}`);
      }

      try {
        const metaSearchRes = await fetch(META_SEARCH_PING_URL);
        console.log(`[PING][MetaSearch] ${new Date().toISOString()} → ${metaSearchRes.status} OK`);
      } catch (e) {
        console.error(`[PING][MetaSearch] ${new Date().toISOString()} → FAIL: ${e.message}`);
      }
    }, PING_INTERVAL);
    console.log(`[PING] Self-ping enabled → ${PING_URL} every 5 min`);
    console.log(`[PING][MetaSearch] Self-ping enabled → ${META_SEARCH_PING_URL} every 5 min`);
  }
});


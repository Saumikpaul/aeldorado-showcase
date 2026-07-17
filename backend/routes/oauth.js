// routes/oauth.js — OAuth 2.0 Endpoints for MCP Clients
// Aeldorado by Solanacy Technologies
//
// Lets Claude.ai / Claude Desktop / Cursor / etc. connect to /mcp via a
// standard OAuth 2.0 Authorization Code + PKCE flow, instead of requiring
// users to paste a raw "aldo-live-..." API key.
//
// Flow:
//   1. Client discovers endpoints via GET /.well-known/oauth-authorization-server
//   2. Client registers via POST /oauth/register (RFC 7591) — gets client_id/secret
//   3. Client opens GET /oauth/authorize in a browser — user logs in with the
//      same Firebase auth already used by the Aeldorado dashboard, approves access
//   4. We redirect back to the client's redirect_uri with ?code=...
//   5. Client calls POST /oauth/token to exchange the code for an access_token
//   6. Client uses "Authorization: Bearer <access_token>" against /mcp

import express from "express";
import {
  registerClient, getClient, verifyClientSecret,
  createAuthCode, exchangeAuthCode, exchangeRefreshToken,
} from "../core/oauth.js";
import { logger } from "../core/logger.js";

export function createOAuthRouter(db, adminAuth) {
  const router = express.Router();

  const BASE_URL = process.env.PUBLIC_API_BASE_URL || "https://api.aeldorado.solanacy.in";

  // ── Discovery: RFC 8414 ────────────────────────────────────────────────────
  router.get("/.well-known/oauth-authorization-server", (req, res) => {
    res.json({
      issuer:                                BASE_URL,
      authorization_endpoint:                `${BASE_URL}/oauth/authorize`,
      token_endpoint:                        `${BASE_URL}/oauth/token`,
      registration_endpoint:                 `${BASE_URL}/oauth/register`,
      response_types_supported:              ["code"],
      grant_types_supported:                 ["authorization_code", "refresh_token"],
      code_challenge_methods_supported:      ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      scopes_supported:                      ["mcp"],
    });
  });

  // Some MCP clients probe this RFC 9728 path too — point back to the same metadata.
  router.get("/.well-known/oauth-protected-resource", (req, res) => {
    res.json({
      resource: `${BASE_URL}/mcp`,
      authorization_servers: [BASE_URL],
    });
  });

  // ── Dynamic Client Registration: RFC 7591 ─────────────────────────────────
  router.post("/oauth/register", express.json(), async (req, res) => {
    try {
      const result = await registerClient(db, req.body || {});
      res.status(201).json(result);
    } catch (e) {
      logger.error("[OAuth] Client registration failed", { error: e.message });
      res.status(e.status || 500).json({ error: "invalid_client_metadata", error_description: e.message });
    }
  });

  // ── Authorization Endpoint ─────────────────────────────────────────────────
  // Renders a small HTML page: Firebase Google sign-in, then an "Allow access"
  // confirmation. On approval, issues a code and redirects to redirect_uri.
  router.get("/oauth/authorize", async (req, res) => {
    const {
      client_id, redirect_uri, state, scope,
      code_challenge, code_challenge_method, response_type,
    } = req.query;

    if (response_type !== "code") {
      return res.status(400).send("Only response_type=code is supported.");
    }

    const client = await getClient(db, client_id);
    if (!client) {
      return res.status(400).send("Unknown client_id. Register first via /oauth/register.");
    }
    if (!client.redirectUris.includes(redirect_uri)) {
      return res.status(400).send("redirect_uri does not match any registered URI for this client.");
    }

    res.send(renderAuthorizePage({
      clientId:            client_id,
      clientName:          client.clientName,
      redirectUri:         redirect_uri,
      state:               state || "",
      scope:               scope || "mcp",
      codeChallenge:       code_challenge || "",
      codeChallengeMethod: code_challenge_method || "",
    }));
  });

  // Called by the authorize page's JS after Firebase login succeeds, carrying
  // the Firebase ID token so we can mint a real authorization code server-side.
  router.post("/oauth/approve", express.json(), async (req, res) => {
    const { id_token, client_id, redirect_uri, state, scope, code_challenge, code_challenge_method } = req.body || {};

    try {
      const decoded = await adminAuth.verifyIdToken(id_token);

      const client = await getClient(db, client_id);
      if (!client || !client.redirectUris.includes(redirect_uri)) {
        return res.status(400).json({ error: "invalid_request" });
      }

      const code = await createAuthCode(db, {
        clientId: client_id,
        redirectUri: redirect_uri,
        userId: decoded.uid,
        codeChallenge: code_challenge || null,
        codeChallengeMethod: code_challenge_method || null,
        scope: scope || "mcp",
      });

      const redirectUrl = new URL(redirect_uri);
      redirectUrl.searchParams.set("code", code);
      if (state) redirectUrl.searchParams.set("state", state);

      res.json({ redirect_to: redirectUrl.toString() });
    } catch (e) {
      logger.error("[OAuth] Approve failed", { error: e.message });
      res.status(401).json({ error: "invalid_token", error_description: "Firebase login verification failed." });
    }
  });

  // ── Token Endpoint ─────────────────────────────────────────────────────────
  router.post("/oauth/token", express.urlencoded({ extended: true }), express.json(), async (req, res) => {
    const body = { ...req.query, ...req.body }; // some clients send form, some JSON
    const { grant_type, client_id, client_secret } = body;

    logger.info("[OAuth] Token request", { grant_type, client_id, redirect_uri: body.redirect_uri, has_code: !!body.code, has_verifier: !!body.code_verifier });
    try {
      const okSecret = await verifyClientSecret(db, client_id, client_secret);
      if (!okSecret) {
        logger.error("[OAuth] Invalid client secret", { client_id });
        return res.status(401).json({ error: "invalid_client" });
      }

      let tokens;
      if (grant_type === "authorization_code") {
        tokens = await exchangeAuthCode(db, {
          code:         body.code,
          clientId:     client_id,
          redirectUri:  body.redirect_uri,
          codeVerifier: body.code_verifier,
        });
      } else if (grant_type === "refresh_token") {
        tokens = await exchangeRefreshToken(db, {
          refreshToken: body.refresh_token,
          clientId:     client_id,
        });
      } else {
        return res.status(400).json({ error: "unsupported_grant_type" });
      }

      logger.info("[OAuth] Token issued successfully", { grant_type, client_id });
      res.json(tokens);
    } catch (e) {
      logger.error("[OAuth] Token exchange failed", { error: e.message, grant_type, redirect_uri: body.redirect_uri });
      res.status(e.status || 500).json({ error: e.oauthError || "server_error", error_description: e.message });
    }
  });

  return router;
}

// ── HTML for the authorize/consent page ──────────────────────────────────────
function renderAuthorizePage({ clientId, clientName, redirectUri, state, scope, codeChallenge, codeChallengeMethod }) {
  const escapedClientName = String(clientName).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Connect to Aeldorado</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<link rel="stylesheet" href="https://aeldorado.solanacy.in/css/legal.css" />
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 24px; margin: 0;
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
  .card {
    position: relative; z-index: 1;
    max-width: 400px; width: 100%;
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
  .auth-logo {
    width: 52px; height: 52px; margin: 0 auto 20px;
    display: flex; align-items: center; justify-content: center;
    position: relative;
    filter: drop-shadow(0 8px 26px rgba(59,130,246,0.55)) drop-shadow(0 2px 8px rgba(124,58,237,0.35));
    animation: float 5s ease-in-out infinite;
  }
  .auth-logo svg { width: 52px; height: 52px; }
  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50%      { transform: translateY(-4px); }
  }
  h1 {
    font-size: 1.5rem; font-weight: 800; letter-spacing: -0.035em;
    color: var(--lg-text-1); margin: 0 0 8px;
    background: linear-gradient(135deg, var(--lg-text-1) 30%, #3b82f6 100%);
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  }
  p { color: var(--lg-text-2); font-size: 0.88rem; line-height: 1.55; margin: 0; }
  button {
    width: 100%; padding: 13px; border-radius: 12px; border: none;
    font-family: var(--lg-font); font-size: 0.92rem; font-weight: 600; cursor: pointer;
    margin-top: 18px; transition: transform 160ms ease, box-shadow 160ms ease, opacity 160ms ease;
  }
  button:hover { transform: translateY(-1px); }
  button:disabled { opacity: 0.6; cursor: default; transform: none; }
  .google-btn {
    background: #fff; color: var(--lg-text-1);
    border: 1px solid rgba(37,99,235,0.14);
    box-shadow: 0 8px 20px -10px rgba(37,99,235,0.20);
  }
  .google-btn:hover { border-color: rgba(37,99,235,0.32); box-shadow: 0 10px 24px -10px rgba(37,99,235,0.28); }
  .allow-btn {
    background: linear-gradient(135deg, #3b82f6, #7c3aed);
    color: #fff; display: none;
    box-shadow: 0 10px 24px -10px rgba(99,102,241,0.45);
  }
  .allow-btn:hover { box-shadow: 0 12px 28px -10px rgba(99,102,241,0.55); }
  .error {
    color: #dc2626; font-size: 0.8rem; margin-top: 14px; display: none;
    background: rgba(220,38,38,0.08); border: 1px solid rgba(220,38,38,0.16);
    border-radius: 10px; padding: 10px 12px;
  }
  .user-row {
    display: none; align-items: center; justify-content: center; gap: 8px;
    margin-top: 16px; font-size: 0.8rem; color: var(--lg-text-2);
    background: rgba(37,99,235,0.06); border-radius: 10px; padding: 8px 12px;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="auth-logo">
      <svg viewBox="0 0 32 32" fill="none" width="44" height="44">
        <defs>
          <linearGradient id="ag-outer" x1="0" y1="0" x2="32" y2="32">
            <stop stop-color="#3b82f6" offset="0%"/>
            <stop stop-color="#7c3aed" offset="100%"/>
          </linearGradient>
          <linearGradient id="ag-inner" x1="0" y1="0" x2="32" y2="32">
            <stop stop-color="#9ca3af" offset="0%"/>
            <stop stop-color="#4b5563" offset="100%"/>
          </linearGradient>
        </defs>
        <path d="M16 3L3 27h6l7-13 7 13h6L16 3z" fill="url(#ag-outer)"/>
        <path d="M16 16l-3.5 6.5h7L16 16z" fill="url(#ag-inner)"/>
      </svg>
    </div>
    <h1>Aeldorado</h1>
    <p><strong>${escapedClientName}</strong> wants to connect to your Aeldorado account to use its AI agents and tools.</p>

    <button id="googleBtn" class="google-btn">Sign in with Google</button>
    <div id="userRow" class="user-row"><span id="userEmail"></span></div>
    <button id="allowBtn" class="allow-btn">Allow Access</button>
    <div id="errorMsg" class="error"></div>
  </div>


  <script type="module">
    import { initializeApp } from "https://www.gstatic.com/firebasejs/11.8.1/firebase-app.js";
    import { getAuth, GoogleAuthProvider, signInWithRedirect, getRedirectResult } from "https://www.gstatic.com/firebasejs/11.8.1/firebase-auth.js";

    const firebaseConfig = {
      apiKey: "YOUR_FIREBASE_API_KEY",
      authDomain: window.location.hostname, // /__/auth/ is proxied on this host → redirect result works
      projectId: "your-project-id",
      storageBucket: "your-project.firebasestorage.app",
      messagingSenderId: "YOUR_SENDER_ID",
      appId: "1:YOUR_SENDER_ID:web:YOUR_APP_ID_HASH",
    };

    // OAuth params injected server-side — save to sessionStorage so they
    // survive the Google redirect round-trip (page fully reloads).
    const OAUTH_PARAMS = {
      client_id:            ${JSON.stringify(clientId)},
      redirect_uri:         ${JSON.stringify(redirectUri)},
      state:                ${JSON.stringify(state)},
      scope:                ${JSON.stringify(scope)},
      code_challenge:       ${JSON.stringify(codeChallenge)},
      code_challenge_method:${JSON.stringify(codeChallengeMethod)},
    };
    sessionStorage.setItem("aldo_oauth", JSON.stringify(OAUTH_PARAMS));

    const app  = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const provider = new GoogleAuthProvider();

    const googleBtn = document.getElementById("googleBtn");
    const allowBtn  = document.getElementById("allowBtn");
    const userRow   = document.getElementById("userRow");
    const userEmail = document.getElementById("userEmail");
    const errorMsg  = document.getElementById("errorMsg");

    function showError(msg) {
      errorMsg.textContent = msg;
      errorMsg.style.display = "block";
    }

    function showUser(email, token) {
      userEmail.textContent = email || "Signed in ✓";
      userRow.style.display = "flex";
      googleBtn.style.display = "none";
      allowBtn.style.display = "block";
      allowBtn.dataset.token = token;
    }

    // ── On page load: check if returning from Google redirect ─────────────────
    async function init() {
      try {
        const result = await getRedirectResult(auth);
        if (result?.user) {
          const token = await result.user.getIdToken();
          showUser(result.user.email, token);
        }
      } catch (e) {
        // Common in iframes or strict environments — not fatal
        console.warn("getRedirectResult:", e.code, e.message);
        if (e.code && e.code !== "auth/null-user") {
          showError("Sign-in error: " + e.message);
        }
      }
    }

    init();

    // ── Sign in button: always use redirect (most reliable cross-browser) ─────
    googleBtn.addEventListener("click", async () => {
      errorMsg.style.display = "none";
      googleBtn.disabled = true;
      googleBtn.textContent = "Redirecting to Google...";
      try {
        await signInWithRedirect(auth, provider);
        // ↑ This navigates away. getRedirectResult() above handles the return.
      } catch (e) {
        showError("Sign-in failed: " + e.message);
        googleBtn.disabled = false;
        googleBtn.textContent = "Sign in with Google";
      }
    });

    // ── Allow button: POST to /oauth/approve then redirect to Claude ──────────
    allowBtn.addEventListener("click", async () => {
      allowBtn.disabled = true;
      allowBtn.textContent = "Connecting...";
      try {
        // Restore params — may have been re-injected from sessionStorage on reload
        const params = JSON.parse(sessionStorage.getItem("aldo_oauth") || "{}");
        const resp = await fetch("/oauth/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id_token:             allowBtn.dataset.token,
            client_id:            params.client_id,
            redirect_uri:         params.redirect_uri,
            state:                params.state,
            scope:                params.scope,
            code_challenge:       params.code_challenge,
            code_challenge_method:params.code_challenge_method,
          }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error_description || data.error || "Approval failed");
        sessionStorage.removeItem("aldo_oauth");
        window.location.href = data.redirect_to;
      } catch (e) {
        showError(e.message);
        allowBtn.disabled = false;
        allowBtn.textContent = "Allow Access";
      }
    });
  </script>
</body>
</html>`;
}

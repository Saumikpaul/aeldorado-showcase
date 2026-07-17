// js/app.js — Main Application Controller (v2)
// Aeldorado by Solanacy Technologies
//
// SPA router, auth, dashboard, keys, vault, playground, docs,
// request logs, analytics charts, IP allowlist, mobile sidebar.

import { initAuth, signInWithGoogle, signInWithEmail, signUpWithEmail, signOutUser, refreshAuthToken } from "./auth.js";
import { toast, hideLoader, animateRing, animateCounter, copyToClipboard, formatDate } from "./ui.js";
import { detectProvider, icon, ICONS } from "./config.js";
import * as api from "./api.js";
import { setTokenRefresher, getBillingStatus, createOrder, verifyPayment, getBillingHistory } from "./api.js";

setTokenRefresher(refreshAuthToken);

// ═══════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════
const state = {
  user: null,
  keys: [],
  vault: [],
  usage: null,
  logs: [],
  analytics: null,
  isSignUp: false,
  projects: [],
};

// ═══════════════════════════════════════════════════════════
//  ROUTER
// ═══════════════════════════════════════════════════════════
function navigate(page) {
  document.querySelectorAll(".page").forEach(p => p.style.display = "none");
  const target = document.getElementById(`page-${page}`);
  if (target) target.style.display = "";

  if (["dashboard","keys","vault","playground","docs","logs","settings","projects","finetune","billing"].includes(page)) {
    document.getElementById("page-dashboard").style.display = "";
    showView(page);
  }
}

function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  const view = document.getElementById(`view-${name}`);
  if (view) view.classList.add("active");

  document.querySelectorAll(".sidebar-link").forEach(l => l.classList.remove("active"));
  const link = document.querySelector(`.sidebar-link[data-nav="${name}"]`);
  if (link) link.classList.add("active");

  // Close mobile sidebar
  document.querySelector(".sidebar")?.classList.remove("open");
  document.getElementById("sidebar-overlay")?.classList.remove("visible");

  if (name === "dashboard") loadDashboard();
  if (name === "keys") { loadKeys(); if (!state.projects.length) loadProjects(); }
  if (name === "vault") loadVault();
  if (name === "playground") { loadPlayground(); if (!state.projects.length) loadProjects(); }
  if (name === "docs") loadDocs();
  if (name === "logs") loadLogs();
  if (name === "settings") loadSettings();
  if (name === "projects") loadProjects();
  if (name === "finetune") loadFineTune();
  if (name === "billing") loadBilling();
}

const navigateTo = (path) => {
  window.history.pushState(null, "", path);
  handleRoute();
};
window.navigateTo = navigateTo;

function handleRoute() {
  const path = window.location.pathname;
  let page = "landing";

  if (path === "/" || path === "/index.html") {
    const hash = window.location.hash.slice(1);
    if (["features", "agents", "pricing"].includes(hash)) {
      navigate("landing");
      setTimeout(() => {
        const section = document.getElementById(hash);
        if (section) section.scrollIntoView({ behavior: "smooth" });
      }, 10);
      return;
    }
    page = "landing";
  } else if (path === "/login" || path === "/signup") {
    page = "auth";
  } else if (path.startsWith("/app/")) {
    const parts = path.split("/");
    page = parts[3] || "dashboard";
  }

  const protectedPages = ["dashboard", "overview", "keys", "vault", "playground", "logs", "settings", "projects", "billing"];
  if (protectedPages.includes(page)) {
    if (!state.user) {
      window.history.replaceState(null, "", "/login");
      navigate("auth");
      return;
    }
    if (page === "overview") page = "dashboard";
  }

  if (state.user && (page === "landing" || page === "auth")) {
    window.history.replaceState(null, "", `/app/${state.user.uid}/overview`);
    navigate("dashboard");
    return;
  }

  navigate(page);
}

// ═══════════════════════════════════════════════════════════
//  AUTH STATE
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
//  BROADCASTS — admin-sent banners shown at the top of dashboard
// ═══════════════════════════════════════════════════════════
const dismissedBroadcasts = new Set(); // in-memory only — reappears next login by design

const BROADCAST_ICONS = {
  info: `<svg class="broadcast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  warning: `<svg class="broadcast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  critical: `<svg class="broadcast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
};

async function loadBroadcasts() {
  const stack = document.getElementById("broadcast-stack");
  if (!stack) return;
  try {
    const data = await api.getActiveBroadcasts();
    const broadcasts = (data?.broadcasts || []).filter(b => !dismissedBroadcasts.has(b.id));

    stack.innerHTML = broadcasts.map(b => `
      <div class="broadcast-banner level-${b.level || "info"}" data-id="${b.id}">
        ${BROADCAST_ICONS[b.level] || BROADCAST_ICONS.info}
        <div class="broadcast-body">${escapeHtmlBroadcast(b.message)}</div>
        <button class="broadcast-dismiss" data-dismiss="${b.id}" aria-label="Dismiss">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    `).join("");

    stack.querySelectorAll("[data-dismiss]").forEach(btn => {
      btn.addEventListener("click", () => {
        dismissedBroadcasts.add(btn.dataset.dismiss);
        btn.closest(".broadcast-banner")?.remove();
      });
    });
  } catch {
    // Broadcasts are a nice-to-have — never block or noisily fail the dashboard over this.
  }
}

function escapeHtmlBroadcast(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}

function onAuthStateChanged(user) {
  state.user = user;
  if (window.hideLoader) window.hideLoader();
  else hideLoader();

  if (user) {
    const avatar = document.getElementById("user-avatar");
    const nameEl = document.getElementById("user-name");
    const tierEl = document.getElementById("user-tier");

    if (avatar) {
      avatar.innerHTML = user.photoURL
        ? `<img src="${user.photoURL}" style="width:100%;height:100%;border-radius:50%" />`
        : `<span>${(user.displayName || user.email || "U")[0].toUpperCase()}</span>`;
    }
    if (nameEl) nameEl.textContent = user.displayName || user.email?.split("@")[0] || "User";
    if (tierEl) tierEl.textContent = "Loading...";

    // Auto-register user and fetch actual tier
    api.registerUser()
      .then(data => {
        if (tierEl && data?.tier) {
          const tierNames = { free: "Free", starter: "Starter", growth: "Growth", pro: "Pro", enterprise_t1: "Enterprise T1", enterprise_t2: "Enterprise T2", developer: "Developer" };
          tierEl.textContent = tierNames[data.tier] || data.tier;
        }
      })
      .catch(() => { if (tierEl) tierEl.textContent = "Free"; });

    loadBroadcasts();

    // Dynamically update all sidebar links with the user's ID
    document.querySelectorAll(".sidebar-link").forEach(link => {
      const page = link.dataset.nav === "dashboard" ? "overview" : link.dataset.nav;
      link.href = `/app/${user.uid}/${page}`;
    });

    const path = window.location.pathname;
    if (path === "/" || path === "/index.html" || path === "/login" || path === "/signup") {
      window.history.replaceState(null, "", `/app/${user.uid}/overview`);
    }
    handleRoute();
  } else {
    // Reset sidebar links for unauthenticated state
    document.querySelectorAll(".sidebar-link").forEach(link => {
      link.removeAttribute("href");
    });

    const path = window.location.pathname;
    if (path.startsWith("/app/")) {
      window.history.replaceState(null, "", "/login");
    }
    handleRoute();
  }
}

// ═══════════════════════════════════════════════════════════
//  DASHBOARD + ANALYTICS CHART
// ═══════════════════════════════════════════════════════════
async function loadDashboard() {
  let usageResult, keysData, analytics;
  try {
    [usageResult, keysData, analytics] = await Promise.allSettled([
      api.getUsage(),
      api.listApiKeys(),
      api.getUsageAnalytics(7),
    ]);

    if (keysData.status === "fulfilled") {
      state.keys = keysData.value.keys || [];
      document.getElementById("stat-keys").textContent = keysData.value.active || state.keys.length || 0;
    }

    if (analytics.status === "fulfilled") {
      state.analytics = analytics.value;
      renderAnalyticsChart(analytics.value);
      animateCounter("stat-calls", analytics.value.totalCalls || 0);
      animateCounter("stat-tokens", analytics.value.totalTokens || 0);

      const latEl = document.getElementById("stat-latency");
      if (latEl) latEl.textContent = `${analytics.value.avgLatencyMs || 0}ms`;

      renderTrendingModels(analytics.value.topModels || []);
      renderTopProjects(analytics.value.topProjects || []);
    }
  } catch {
    // defaults
  }

  if (usageResult && usageResult.status === "fulfilled") {
    updateUsageDisplay(usageResult.value);
  } else {
    updateUsageDisplay({
      usage: { daily: 0, weekly: 0, monthly: 0 },
      limits: { daily: 100, weekly: 500, monthly: 1500 },
      tier: "free", tierName: "Free",
    });
  }
}

function renderAnalyticsChart(data) {
  const canvas = document.getElementById("chart-canvas");
  if (!canvas || !data?.dailyCalls) return;

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;

  // Get last 7 days
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }

  const values = days.map(d => data.dailyCalls[d] || 0);
  const maxVal = Math.max(...values, 1);
  const padding = { top: 20, right: 20, bottom: 30, left: 40 };
  const chartW = W - padding.left - padding.right;
  const chartH = H - padding.top - padding.bottom;

  // Clear
  ctx.clearRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (chartH / 4) * i;
    ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(W - padding.right, y); ctx.stroke();
  }

  // Points
  const points = values.map((v, i) => ({
    x: padding.left + (chartW / (values.length - 1)) * i,
    y: padding.top + chartH - (v / maxVal) * chartH,
  }));

  // Gradient fill
  const grad = ctx.createLinearGradient(0, padding.top, 0, H - padding.bottom);
  grad.addColorStop(0, "rgba(59, 130, 246, 0.35)");
  grad.addColorStop(1, "rgba(59, 130, 246, 0.0)");

  ctx.beginPath();
  ctx.moveTo(points[0].x, H - padding.bottom);
  points.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.lineTo(points[points.length - 1].x, H - padding.bottom);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.stroke();

  // Dots
  points.forEach(p => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#3b82f6";
    ctx.fill();
    ctx.strokeStyle = "#111520";
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  // X labels
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.font = "11px Inter, system-ui";
  ctx.textAlign = "center";
  days.forEach((d, i) => {
    const x = padding.left + (chartW / (days.length - 1)) * i;
    ctx.fillText(d.slice(5), x, H - 8);
  });

  // Y labels
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (chartH / 4) * i;
    const val = Math.round(maxVal - (maxVal / 4) * i);
    ctx.fillText(val, padding.left - 6, y + 4);
  }
}

function renderTrendingModels(topModels) {
  const list = document.getElementById("trending-models-list");
  if (!list) return;

  if (!topModels || topModels.length === 0) {
    list.innerHTML = '<div class="empty-state-sm">No model usage yet — make a few API calls to see trends here.</div>';
    return;
  }

  const maxCalls = Math.max(...topModels.map(m => m.calls), 1);

  list.innerHTML = topModels.map((m, i) => `
    <div class="trending-model-row" style="animation: cardFadeIn 0.4s ${i * 60}ms both;">
      <div class="trending-model-top">
        <span class="trending-model-name">${escHtml(m.model)}</span>
        <span class="trending-model-count">${m.calls} call${m.calls === 1 ? "" : "s"}</span>
      </div>
      <div class="trending-model-bar-track">
        <div class="trending-model-bar-fill" style="width:${Math.round((m.calls / maxCalls) * 100)}%"></div>
      </div>
    </div>
  `).join("");
}

function renderTopProjects(topProjects) {
  const list = document.getElementById("top-projects-list");
  if (!list) return;

  if (!topProjects || topProjects.length === 0) {
    list.innerHTML = '<div class="empty-state-sm">No project activity yet — link a key to a project and start calling.</div>';
    return;
  }

  const maxCalls = Math.max(...topProjects.map(p => p.calls), 1);

  list.innerHTML = topProjects.map((p, i) => `
    <div class="top-project-row" style="animation: cardFadeIn 0.4s ${i * 60}ms both;">
      <div class="top-project-rank">${i + 1}</div>
      <div class="top-project-info">
        <div class="top-project-name">${escHtml(p.name)}</div>
        <div class="top-project-calls">${p.calls} call${p.calls === 1 ? "" : "s"}</div>
      </div>
      <div class="top-project-bar">
        <div class="top-project-bar-fill" style="width:${Math.round((p.calls / maxCalls) * 100)}%"></div>
      </div>
    </div>
  `).join("");
}

function updateUsageDisplay(data) {
  const u = data.usage || {};
  const l = data.limits || {};

  animateCounter("val-daily", u.daily || 0);
  animateCounter("val-weekly", u.weekly || 0);
  animateCounter("val-monthly", u.monthly || 0);

  document.getElementById("limit-daily").textContent = `/ ${l.daily === "unlimited" ? "∞" : l.daily?.toLocaleString()}`;
  document.getElementById("limit-weekly").textContent = `/ ${l.weekly === "unlimited" ? "∞" : l.weekly?.toLocaleString()}`;
  document.getElementById("limit-monthly").textContent = `/ ${l.monthly === "unlimited" ? "∞" : l.monthly?.toLocaleString()}`;

  const maxD = l.daily === "unlimited" ? Infinity : l.daily;
  const maxW = l.weekly === "unlimited" ? Infinity : l.weekly;
  const maxM = l.monthly === "unlimited" ? Infinity : l.monthly;
  animateRing("ring-daily-fill", u.daily || 0, maxD);
  animateRing("ring-weekly-fill", u.weekly || 0, maxW);
  animateRing("ring-monthly-fill", u.monthly || 0, maxM);

  const tierBadge = document.getElementById("dash-tier");
  if (tierBadge) tierBadge.textContent = data.tierName || data.tier || "Free";
  const sidebarTier = document.getElementById("user-tier");
  if (sidebarTier) sidebarTier.textContent = data.tierName || data.tier || "Free";
}

// ═══════════════════════════════════════════════════════════
//  API KEYS
// ═══════════════════════════════════════════════════════════
async function loadKeys() {
  const list = document.getElementById("keys-list");
  list.innerHTML = `
    <div class="keys-skeleton-wrap">
      ${Array.from({ length: 3 }).map((_, i) => `
        <div class="keys-skeleton-row" style="animation-delay:${i * 50}ms">
          <div class="keys-skeleton-info">
            <div class="keys-skeleton-cell w-name"></div>
            <div class="keys-skeleton-cell w-prefix"></div>
            <div class="keys-skeleton-cell w-scope"></div>
          </div>
          <div class="keys-skeleton-meta">
            <div class="keys-skeleton-cell w-date"></div>
          </div>
        </div>
      `).join("")}
    </div>`;
  try {
    const data = await api.listApiKeys();
    state.keys = data.keys || [];
    renderKeys();
  } catch { list.innerHTML = '<div class="empty-state">No API keys yet. Generate your first key above.</div>'; }
}

function renderKeys() {
  const list = document.getElementById("keys-list");
  if (!state.keys.length) {
    list.innerHTML = '<div class="empty-state">No API keys yet. Generate your first key above.</div>';
    return;
  }
  list.innerHTML = state.keys.map((k, i) => {
    const projectBadge = k.projectId
      ? `<span class="key-badge key-badge-project">🗂 Project</span>`
      : '';
    const playgroundBadge = k.isPlaygroundKey
      ? `<span class="key-badge key-badge-playground">🎮 Playground</span>`
      : '';
    return `
    <div class="key-item" data-key-index="${i}" style="cursor:pointer;">
      <div class="key-item-info">
        <div class="key-item-name">${escHtml(k.name)}</div>
        <div class="key-item-prefix">${escHtml(k.prefix)}${"•".repeat(26)}</div>
        <div class="key-item-badges">
          <span class="key-item-scope">${escHtml(k.scope)}</span>
          ${projectBadge}${playgroundBadge}
        </div>
      </div>
      <div class="key-item-meta">
        <div class="key-item-date">Created ${formatDate(k.createdAt)}</div>
        ${k.lastUsed ? `<div class="key-item-date">Last used ${formatDate(k.lastUsed)}</div>` : ""}
      </div>
    </div>
  `}).join("");

  // Event delegation — no inline onclick, no escaping issues
  list.querySelectorAll(".key-item[data-key-index]").forEach(el => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.keyIndex);
      const k = state.keys[idx];
      if (k) window._openKeyModal(null, k.name, k.scope, k.prefix, k.projectId || null, k.isPublicFacing || false, k.isPlaygroundKey || false);
    });
  });
}

let activeKeyPrefix = null;

window._openKeyModal = function(rawKey, name, scope, prefix, projectId, isPublicFacing, isPlaygroundKey) {
  activeKeyPrefix = prefix;
  const rawEl = document.getElementById("mdl-key-raw");

  if (rawKey) {
    rawEl.textContent = rawKey;
  } else {
    // Raw key isn't included in the list response for security — fetch it
    // on demand via the reveal endpoint rather than showing the masked
    // prefix mislabeled as the "full" key.
    rawEl.textContent = "Loading…";
    api.revealApiKey(prefix)
      .then(r => { rawEl.textContent = r.rawKey || "Unable to load key."; })
      .catch(() => { rawEl.textContent = "Unable to load key — try again."; });
  }

  document.getElementById("mdl-key-name").value        = name;
  document.getElementById("mdl-key-scope").value       = scope;

  // Public-facing toggle — disabled for playground keys (backend rejects
  // that combination, since playground keys already have full memory access
  // and "public-facing" is a concept specific to external customer-facing use).
  const pubCheckbox = document.getElementById("mdl-key-public-facing");
  if (pubCheckbox) {
    pubCheckbox.checked  = isPublicFacing === true;
    pubCheckbox.disabled = isPlaygroundKey === true;
    const pubRow = pubCheckbox.closest(".lg-toggle-row") || pubCheckbox.closest(".form-group");
    if (pubRow) {
      pubRow.style.opacity = isPlaygroundKey ? "0.5" : "1";
      pubRow.title = isPlaygroundKey ? "Playground keys can't be public-facing" : "";
    }
  }

  // Populate project dropdown
  const projSel  = document.getElementById("mdl-key-project");
  const memHint  = document.getElementById("mdl-proj-memory-hint");
  if (projSel) {
    projSel.innerHTML = '<option value="">No Project (standalone)</option>';
    state.projects.forEach(p => {
      const opt = document.createElement("option");
      opt.value       = p.projectId;
      opt.textContent = p.name + (p.memoryEnabled ? " 🟢" : " ⚫");
      projSel.appendChild(opt);
    });
    projSel.value = projectId || "";
    // Show memory hint for current project
    const proj = state.projects.find(p => p.projectId === (projectId || ""));
    if (proj && memHint) {
      memHint.textContent = proj.memoryEnabled
        ? "🟢 Memory ON — facts auto-extracted every 20 messages"
        : "⚫ Memory OFF — enable memory in Projects to activate";
      memHint.style.display = "";
    } else if (memHint) {
      memHint.style.display = "none";
    }
    // Update hint when project dropdown changes
    projSel.onchange = () => {
      const p2 = state.projects.find(p => p.projectId === projSel.value);
      if (memHint) {
        memHint.textContent = p2
          ? (p2.memoryEnabled ? "🟢 Memory ON — facts auto-extracted every 20 messages" : "⚫ Memory OFF — enable memory in Projects to activate")
          : "";
        memHint.style.display = p2 ? "" : "none";
      }
    };
  }

  document.getElementById("modal-overlay").style.display    = "flex";
  document.getElementById("modal-key-details").style.display = "block";
};

// Modal copy button
document.getElementById("btn-copy-key")?.addEventListener("click", () => {
  const keyText = document.getElementById("mdl-key-raw")?.textContent?.trim();
  if (keyText) {
    navigator.clipboard.writeText(keyText);
    toast("API key copied!", "success");
  }
});

// Modal close
document.getElementById("btn-close-key-modal")?.addEventListener("click", () => {
  document.getElementById("modal-overlay").style.display = "none";
  document.getElementById("modal-key-details").style.display = "none";
});

document.getElementById("btn-save-scope")?.addEventListener("click", async () => {
  const newScope     = document.getElementById("mdl-key-scope").value;
  const newProjectId = document.getElementById("mdl-key-project")?.value ?? undefined;
  const newPublicFacing = document.getElementById("mdl-key-public-facing")?.checked ?? undefined;
  if (!activeKeyPrefix) return;
  try {
    await api.updateApiKey(activeKeyPrefix, newScope, newProjectId === "" ? null : newProjectId, newPublicFacing);
    toast("API key updated.", "success");
    document.getElementById("modal-overlay").style.display    = "none";
    document.getElementById("modal-key-details").style.display = "none";
    loadKeys();
  } catch (e) {
    toast("Failed: " + e.message, "error");
  }
});

document.getElementById("btn-revoke-modal")?.addEventListener("click", async () => {
  if (!activeKeyPrefix) return;
  if (!confirm(`This key will be permanently deleted from the database. Cannot be undone.`)) return;
  try { 
    await api.revokeApiKey(activeKeyPrefix); 
    toast("API key revoked.", "success"); 
    document.getElementById("modal-overlay").style.display = "none";
    document.getElementById("modal-key-details").style.display = "none";
    loadKeys(); 
  }
  catch (e) { toast("Failed: " + e.message, "error"); }
});

window._revokeKey = async function(prefix) {
  if (!confirm(`Revoke key "${prefix}..."? This cannot be undone.`)) return;
  try { await api.revokeApiKey(prefix); toast("API key revoked.", "success"); loadKeys(); }
  catch (e) { toast("Failed: " + e.message, "error"); }
};

// ═══════════════════════════════════════════════════════════
//  KEY GENERATION PANEL HANDLERS
// ═══════════════════════════════════════════════════════════

// Populate project dropdown in keygen panel
function populateKeygenProjects() {
  const sel = document.getElementById("keygen-project");
  if (!sel) return;
  sel.innerHTML = '<option value="">No Project (standalone key)</option>';
  (state.projects || []).forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.projectId;
    opt.textContent = p.name + (p.memoryEnabled ? " 🟢" : " ⚫");
    sel.appendChild(opt);
  });
}

// Show/hide the keygen panel
document.getElementById("btn-generate-key")?.addEventListener("click", () => {
  const panel = document.getElementById("keygen-panel");
  const result = document.getElementById("keygen-result");
  if (!panel) return;
  populateKeygenProjects();
  // Reset form
  const nameInput = document.getElementById("keygen-name");
  if (nameInput) nameInput.value = "";
  const scopeSel = document.getElementById("keygen-scope");
  if (scopeSel) scopeSel.value = "all";
  const pgCheck = document.getElementById("keygen-playground");
  if (pgCheck) pgCheck.checked = false;
  const pubCheck = document.getElementById("keygen-public-facing");
  if (pubCheck) { pubCheck.checked = false; pubCheck.disabled = false; }
  const pubGroup = document.getElementById("keygen-public-facing-group");
  if (pubGroup) pubGroup.style.opacity = "1";
  if (result) result.style.display = "none";
  panel.style.display = panel.style.display === "none" ? "block" : "none";
});

// Playground Mode and Public-Facing are mutually exclusive — a key can't be
// both (Playground keys already have full memory access; "public-facing" is
// a concept specific to external customer-facing widgets/sites).
document.getElementById("keygen-playground")?.addEventListener("change", (e) => {
  const pubCheck = document.getElementById("keygen-public-facing");
  const pubGroup = document.getElementById("keygen-public-facing-group");
  if (!pubCheck) return;
  if (e.target.checked) {
    pubCheck.checked = false;
    pubCheck.disabled = true;
    if (pubGroup) pubGroup.style.opacity = "0.5";
  } else {
    pubCheck.disabled = false;
    if (pubGroup) pubGroup.style.opacity = "1";
  }
});
document.getElementById("keygen-public-facing")?.addEventListener("change", (e) => {
  const pgCheck = document.getElementById("keygen-playground");
  if (!pgCheck) return;
  if (e.target.checked) pgCheck.checked = false;
});

// Cancel button hides the panel
document.getElementById("btn-keygen-cancel")?.addEventListener("click", () => {
  const panel = document.getElementById("keygen-panel");
  if (panel) panel.style.display = "none";
});

// Submit — generate the key
document.getElementById("btn-keygen-submit")?.addEventListener("click", async () => {
  const name        = document.getElementById("keygen-name")?.value?.trim();
  const scope       = document.getElementById("keygen-scope")?.value || "all";
  const projectId   = document.getElementById("keygen-project")?.value || null;
  const isPlayground = document.getElementById("keygen-playground")?.checked || false;
  const isPublicFacing = document.getElementById("keygen-public-facing")?.checked || false;

  if (!name) { toast("Enter a key name.", "error"); return; }

  const btn = document.getElementById("btn-keygen-submit");
  btn.disabled = true;
  btn.textContent = "Generating…";

  try {
    const data = await api.generateApiKey(name, scope, projectId || null, isPlayground, isPublicFacing);
    const rawKey = data.key || data.rawKey || data.apiKey || "";

    // Show generated key
    const rawEl = document.getElementById("keygen-raw-key");
    if (rawEl) rawEl.textContent = rawKey;
    const result = document.getElementById("keygen-result");
    if (result) result.style.display = "block";

    // Hide panel
    const panel = document.getElementById("keygen-panel");
    if (panel) panel.style.display = "none";

    toast("API key generated!", "success");
    loadKeys();
  } catch (e) {
    toast("Failed to generate key: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Generate";
  }
});

// Copy generated key
document.getElementById("btn-copy-keygen")?.addEventListener("click", () => {
  const key = document.getElementById("keygen-raw-key")?.textContent?.trim();
  if (key) {
    navigator.clipboard.writeText(key);
    toast("Key copied!", "success");
  }
});

// ═══════════════════════════════════════════════════════════
//  KEY VAULT
// ═══════════════════════════════════════════════════════════
async function loadVault() {
  const list = document.getElementById("vault-list");
  list.innerHTML = `
    <div class="vault-skeleton-wrap">
      ${Array.from({ length: 3 }).map((_, i) => `
        <div class="vault-skeleton-row" style="animation-delay:${i * 50}ms">
          <div class="vault-skeleton-info">
            <div class="vault-skeleton-icon"></div>
            <div class="vault-skeleton-details">
              <div class="vault-skeleton-cell w-name"></div>
              <div class="vault-skeleton-cell w-masked"></div>
            </div>
          </div>
          <div class="vault-skeleton-actions">
            <div class="vault-skeleton-cell w-btn"></div>
            <div class="vault-skeleton-cell w-btn"></div>
          </div>
        </div>
      `).join("")}
    </div>`;
  try {
    const data = await api.listVaultKeys();
    state.vault = data.providers || [];
    renderVault();
  } catch { list.innerHTML = '<div class="empty-state">No keys stored yet. Add your first AI provider key above.</div>'; }
}

function renderVault() {
  const list = document.getElementById("vault-list");
  const header = document.getElementById("vault-list-header");
  const countEl = document.getElementById("vault-key-count");

  if (!state.vault.length) {
    list.innerHTML = "";
    if (header) header.style.display = "none";
    return;
  }

  if (header) {
    header.style.display = "flex";
    if (countEl) countEl.textContent = state.vault.length + (state.vault.length === 1 ? " key" : " keys");
  }

  list.innerHTML = state.vault.map((p, i) => {
    const models = p.models && p.models.length ? p.models : null;
    const modelControl = models
      ? `<select class="vault-model-select" onchange="window._updateVaultModel('${escAttr(p.name)}', this.value)">
           ${models.map(m => `<option value="${escAttr(m.id)}" ${m.id === p.defaultModel ? "selected" : ""}>${escHtml(m.name)}</option>`).join("")}
         </select>`
      : (p.defaultModel ? `<div class="vault-item-model">Default: ${escHtml(p.defaultModel)}</div>` : "");

    const delayMs = 60 + i * 50;
    return `
    <div class="vault-item" style="animation-delay:${delayMs}ms">
      <div class="vault-item-info">
        <div class="vault-item-icon">${icon(p.icon || p.name?.toLowerCase() || "vault")}</div>
        <div class="vault-item-details">
          <div class="vault-item-name">${escHtml(p.displayName || p.name)}</div>
          <div class="vault-item-masked">${escHtml(p.masked)}</div>
          ${modelControl}
        </div>
      </div>
      <div class="vault-item-actions">
        <button class="lg-btn-ghost" onclick="window._verifyVault('${escAttr(p.name)}')">${icon("check")} Verify</button>
        <button class="lg-btn-danger" onclick="window._removeVault('${escAttr(p.name)}')">${icon("trash")} Remove</button>
      </div>
    </div>
  `;
  }).join("");
}

window._updateVaultModel = async function(provider, defaultModel) {
  try {
    await api.updateVaultModel(provider, defaultModel);
    const entry = state.vault.find(p => p.name === provider);
    if (entry) entry.defaultModel = defaultModel;
    toast("Default model updated.", "success");
  } catch (e) {
    toast("Failed to update model: " + e.message, "error");
    loadVault();
  }
};

window._verifyVault = async function(provider) {
  const password = prompt("Enter your encryption password to verify:");
  if (!password) return;
  try { const r = await api.verifyVaultKey(provider, password); toast(r.message, r.verified ? "success" : "error"); }
  catch (e) { toast("Verification failed: " + e.message, "error"); }
};
window._removeVault = async function(provider) {
  if (!confirm(`Remove ${provider} key from vault?`)) return;
  try { await api.removeVaultKey(provider); toast("Key removed.", "success"); loadVault(); }
  catch (e) { toast("Failed: " + e.message, "error"); }
};

// ═══════════════════════════════════════════════════════════
//  REQUEST LOGS (NEW)
// ═══════════════════════════════════════════════════════════
const PG_LOGS_PAGE_SIZE = 5;
let logsCursorStack = [null]; // cursorStack[i] = cursor used to fetch page i (0-indexed); page 0 = null
let logsPageIndex = 0;
let logsHasMore = false;
let logsLoading = false;

async function loadLogs(targetPage = 0) {
  if (logsLoading) return;
  logsLoading = true;
  const container = document.getElementById("logs-list");
  container.innerHTML = `
    <div class="logs-skeleton-wrap">
      ${Array.from({ length: 6 }).map(() => `
        <div class="logs-skeleton-row">
          <div class="logs-skeleton-cell w-time"></div>
          <div class="logs-skeleton-cell w-agent"></div>
          <div class="logs-skeleton-cell w-model"></div>
          <div class="logs-skeleton-cell w-provider"></div>
          <div class="logs-skeleton-cell w-badge"></div>
          <div class="logs-skeleton-cell w-badge"></div>
          <div class="logs-skeleton-cell w-latency"></div>
          <div class="logs-skeleton-cell w-tokens"></div>
        </div>
      `).join("")}
    </div>`;
  try {
    const cursor = logsCursorStack[targetPage] || null;
    const data = await api.getRequestLogs(PG_LOGS_PAGE_SIZE, null, cursor);
    state.logs = data.logs || [];
    logsHasMore = !!data.hasMore;
    logsPageIndex = targetPage;

    // Remember the cursor for the *next* page so Forward works,
    // without re-fetching pages we've already paid the read cost for.
    if (logsHasMore && data.nextCursor) {
      logsCursorStack[targetPage + 1] = data.nextCursor;
    }
    renderLogs();
  } catch {
    container.innerHTML = '<div class="empty-state">No request logs yet. Make API calls to see them here.</div>';
  } finally {
    logsLoading = false;
  }
}

function renderLogs() {
  const container = document.getElementById("logs-list");
  if (!state.logs.length && logsPageIndex === 0) {
    container.innerHTML = '<div class="empty-state">No request logs yet.</div>';
    return;
  }

  const hasPrev = logsPageIndex > 0;
  const hasNext = logsHasMore;

  container.innerHTML = `
    <div class="logs-table-wrap">
      <table class="logs-table">
        <thead>
          <tr>
            <th>Time</th><th>Agent</th><th>Model</th><th>Provider</th>
            <th>Routing</th><th>Status</th><th>Latency</th><th>Tokens</th>
          </tr>
        </thead>
        <tbody>
          ${state.logs.map(log => `
            <tr class="log-row ${log.status === 'error' ? 'log-error' : ''}">
              <td class="log-time">${formatLogTime(log.timestamp)}</td>
              <td><span class="log-agent">${icon(log.agent)} ${escHtml(log.agent)}</span></td>
              <td class="log-model">${escHtml(log.model)}</td>
              <td>${icon(log.provider)} ${escHtml(log.provider)}</td>
              <td><span class="badge badge-${escAttr(log.routing)}">${escHtml(log.routing)}</span></td>
              <td><span class="badge badge-${escAttr(log.status)}">${escHtml(log.status)}</span></td>
              <td class="log-latency">${log.latencyMs}ms</td>
              <td class="log-tokens">${(log.tokens?.total || 0).toLocaleString()}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <div class="logs-pagination">
      <button class="logs-page-btn" id="logs-prev-btn" ${hasPrev ? "" : "disabled"}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>
        Prev
      </button>
      <span class="logs-page-indicator">Page ${logsPageIndex + 1}</span>
      <button class="logs-page-btn" id="logs-next-btn" ${hasNext ? "" : "disabled"}>
        Next
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
    </div>
  `;

  document.getElementById("logs-prev-btn")?.addEventListener("click", () => {
    if (logsPageIndex > 0) loadLogs(logsPageIndex - 1);
  });
  document.getElementById("logs-next-btn")?.addEventListener("click", () => {
    if (logsHasMore) loadLogs(logsPageIndex + 1);
  });
}

function formatLogTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    + " " + d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

// ═══════════════════════════════════════════════════════════
//  SETTINGS — IP ALLOWLIST (NEW)
// ═══════════════════════════════════════════════════════════
async function loadSettings() {
  try {
    const data = await api.getUserSettings();
    const settings = data.settings || {};
    const ipList = settings.ipAllowlist || [];
    document.getElementById("ip-allowlist-input").value = ipList.join("\n");
    document.getElementById("ip-count").textContent = ipList.length === 0 ? "All IPs allowed" : `${ipList.length} IP(s) allowlisted`;
  } catch { /* defaults */ }

  // Load MCP vault status
  try {
    const status = await api.getMcpVaultStatus();
    _renderMcpVaultStatus(status);
  } catch {
    _renderMcpVaultStatus({ enabled: false });
  }
}

function _renderMcpVaultStatus(status) {
  const badge   = document.getElementById("mcp-vault-status-badge");
  const subtext = document.getElementById("mcp-vault-status-text");
  const enableForm  = document.getElementById("mcp-vault-enable-form");
  const enabledForm = document.getElementById("mcp-vault-enabled-form");
  if (!badge) return;

  if (status.enabled) {
    badge.textContent = "Enabled";
    badge.className = "status-badge badge-success";
    subtext.textContent = `Active — ${status.providerCount} provider(s) synced`;
    enableForm.style.display  = "none";
    enabledForm.style.display = "block";
  } else {
    badge.textContent = "Disabled";
    badge.className = "status-badge badge-error";
    subtext.textContent = "MCP clients cannot call agents yet";
    enableForm.style.display  = "block";
    enabledForm.style.display = "none";
  }
}

window._toggleMcpVaultPwEye = function() {
  const input = document.getElementById("mcp-vault-password-input");
  const icon  = document.getElementById("mcp-vault-eye-icon");
  if (!input) return;
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  icon.innerHTML = show
    ? '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
    : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
};

window._enableMcpVault = async function() {
  const pw  = document.getElementById("mcp-vault-password-input")?.value?.trim();
  const btn = document.getElementById("btn-mcp-vault-enable");
  if (!pw) return toast("Enter your vault password.", "error");
  btn.disabled = true;
  btn.textContent = "Enabling...";
  try {
    const res = await api.enableMcpVault(pw);
    toast(res.message || "MCP Agent Access enabled!", "success");
    document.getElementById("mcp-vault-password-input").value = "";
    _renderMcpVaultStatus({ enabled: true, providerCount: res.providerCount });
  } catch (e) {
    toast(e.message || "Failed to enable.", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M5 13l4 4L19 7"/></svg> Enable MCP Agent Access';
  }
};

window._syncMcpVault = async function() {
  const pw = document.getElementById("mcp-vault-sync-password-input")?.value?.trim();
  if (!pw) return toast("Enter your vault password to sync.", "error");
  try {
    const res = await api.syncMcpVault(pw);
    toast(res.message || "Keys synced!", "success");
    document.getElementById("mcp-vault-sync-password-input").value = "";
    _renderMcpVaultStatus({ enabled: true, providerCount: res.providerCount });
  } catch (e) {
    toast(e.message || "Sync failed.", "error");
  }
};

window._disableMcpVault = async function() {
  if (!confirm("Disable MCP Agent Access? MCP clients will no longer be able to call your agents.")) return;
  try {
    await api.disableMcpVault();
    toast("MCP Agent Access disabled.", "success");
    _renderMcpVaultStatus({ enabled: false });
  } catch (e) {
    toast(e.message || "Failed to disable.", "error");
  }
};

// ═══════════════════════════════════════════════════════════
//  PROJECTS & MEMORY
// ═══════════════════════════════════════════════════════════
let activeProjectId = null;

async function loadProjects() {
  const list = document.getElementById("projects-list");
  const statsEl = document.getElementById("projects-stats");
  if (!list) return;
  list.innerHTML = Array.from({ length: 3 }).map(() => `
    <div class="project-card-skeleton">
      <div class="proj-skel-header">
        <div class="proj-skel-icon"></div>
        <div class="proj-skel-titles">
          <div class="proj-skel-line w60"></div>
          <div class="proj-skel-line w40"></div>
        </div>
        <div class="proj-skel-badge"></div>
      </div>
      <div class="proj-skel-row">
        <div class="proj-skel-pill"></div>
        <div class="proj-skel-line w30"></div>
      </div>
      <div class="proj-skel-actions">
        <div class="proj-skel-btn"></div>
        <div class="proj-skel-btn"></div>
      </div>
    </div>
  `).join("");
  try {
    const data = await api.listProjects();
    state.projects = data.projects || [];
    if (statsEl) statsEl.textContent = `${state.projects.length} / 10 projects`;
    renderProjects();
    // Re-sync playground memory chip in case it rendered before projects loaded
    const pgSel = document.getElementById("pg-key-select");
    if (pgSel && pgSel.value !== "") {
      const idx = parseInt(pgSel.value);
      const key = isNaN(idx) ? null : state.keys[idx];
      if (key) updatePgMemoryChip(key);
    }
  } catch (e) {
    list.innerHTML = `<div class="empty-state">Failed to load projects. <button class="btn btn-sm btn-ghost" onclick="loadProjects()">Retry</button></div>`;
  }
}

function renderProjects() {
  const list = document.getElementById("projects-list");
  if (!list) return;

  if (!state.projects.length) {
    list.innerHTML = `
      <div class="empty-state projects-empty">
        <div class="empty-icon">🗂</div>
        <p>No projects yet.</p>
        <p style="font-size:0.85rem;opacity:0.6;">Create a project to group API keys under a shared memory pool.</p>
      </div>`;
    return;
  }

  list.innerHTML = state.projects.map((p, i) => {
    const memClass  = p.memoryEnabled ? "memory-on" : "memory-off";
    const memLabel  = p.memoryEnabled ? "Memory ON" : "Memory OFF";
    const memIcon   = p.memoryEnabled ? "🟢" : "⚫";
    const tierBadge = p.tier === "free"
      ? `<span class="proj-tier-badge tier-free">Free</span>`
      : `<span class="proj-tier-badge tier-paid">${escHtml(p.tier)}</span>`;

    return `
    <div class="project-card" data-project-index="${i}" style="animation-delay:${i * 60}ms">
      <div class="project-card-header">
        <div class="project-card-title">
          <div class="proj-icon">🗂</div>
          <div>
            <div class="proj-name">${escHtml(p.name)}</div>
            <div class="proj-id">${escHtml(p.projectId)}</div>
          </div>
        </div>
        ${tierBadge}
      </div>
      <div class="project-card-body">
        <div class="proj-memory-status ${memClass}">
          <span class="mem-dot">${memIcon}</span>
          <span>${memLabel}</span>
        </div>
        <div class="proj-created">Created ${formatDate(p.createdAt)}</div>
      </div>
      <div class="project-card-actions">
        <button class="btn btn-sm btn-ghost btn-proj-memory"
          data-proj-id="${escHtml(p.projectId)}"
          data-proj-tier="${escHtml(p.tier)}"
          data-mem-enabled="${p.memoryEnabled}">
          ${p.memoryEnabled ? "🔴 Disable Memory" : "🟢 Enable Memory"}
        </button>
        ${p.memoryEnabled ? `
        <button class="btn btn-sm btn-ghost btn-proj-view-mem" data-proj-id="${escHtml(p.projectId)}">
          👁 View Memory
        </button>` : ""}
        <button class="btn btn-sm btn-ghost btn-danger btn-proj-delete"
          data-proj-id="${escHtml(p.projectId)}"
          data-proj-name="${escHtml(p.name)}">
          🗑 Delete
        </button>
      </div>
    </div>`;
  }).join("");

  list.querySelectorAll(".btn-proj-memory").forEach(btn => {
    btn.addEventListener("click", async () => {
      const projId  = btn.dataset.projId;
      const tier    = btn.dataset.projTier;
      const enabled = btn.dataset.memEnabled === "true";
      if (!enabled && tier === "free") {
        toast("Memory requires Starter or Pro tier. Upgrade to use project memory.", "error");
        return;
      }
      btn.disabled = true; btn.textContent = "Updating...";
      try {
        await api.toggleProjectMemory(projId, !enabled);
        toast(`Memory ${!enabled ? "enabled" : "disabled"} for project.`, "success");
        loadProjects();
      } catch (e) {
        toast("Failed: " + e.message, "error");
        btn.disabled = false;
        btn.textContent = enabled ? "🔴 Disable Memory" : "🟢 Enable Memory";
      }
    });
  });

  list.querySelectorAll(".btn-proj-view-mem").forEach(btn => {
    btn.addEventListener("click", () => openMemoryModal(btn.dataset.projId));
  });

  list.querySelectorAll(".btn-proj-delete").forEach(btn => {
    btn.addEventListener("click", async () => {
      const projId = btn.dataset.projId;
      const projName = btn.dataset.projName;
      if (!confirm(`Delete project "${projName}"? This also wipes all its memory. Cannot be undone.`)) return;
      try {
        await api.deleteProject(projId);
        toast("Project deleted.", "success");
        loadProjects();
      } catch (e) { toast("Failed: " + e.message, "error"); }
    });
  });
}

async function openMemoryModal(projectId) {
  const modal   = document.getElementById("modal-memory");
  const overlay = document.getElementById("modal-overlay");
  if (!modal || !overlay) return;

  activeProjectId = projectId;
  document.getElementById("mem-modal-proj-id").textContent = projectId;
  document.getElementById("mem-modal-facts").innerHTML = `
    <div class="mem-skeleton-wrap">
      ${Array.from({ length: 4 }).map((_, i) => `
        <div class="mem-skeleton-row" style="animation-delay:${i * 40}ms">
          <div class="mem-skeleton-num"></div>
          <div class="mem-skeleton-text"></div>
          <div class="mem-skeleton-time"></div>
        </div>
      `).join("")}
    </div>`;

  overlay.style.display = "flex";
  modal.style.display   = "block";

  try {
    const data  = await api.getProjectMemory(projectId);
    const facts   = data.facts   || [];
    const summary = data.summary || null;

    let html = "";
    if (summary) html += `<div class="mem-summary"><strong>📝 Summary:</strong> ${escHtml(summary)}</div>`;
    if (facts.length) {
      html += `<div class="mem-facts-header">Known Facts (${facts.length})</div>`;
      html += facts.map((f, i) => `
        <div class="mem-fact-item" style="animation-delay:${i*30}ms">
          <span class="mem-fact-num">${i + 1}</span>
          <span class="mem-fact-text">${escHtml(f.fact)}</span>
          <span class="mem-fact-time">${formatDate(f.extractedAt)}</span>
          ${f.manual ? '<span class="mem-fact-badge">manual</span>' : ''}
        </div>`).join("");
    } else {
      html += '<div class="empty-state" style="padding:2rem">No facts extracted yet. Memory builds automatically every 20 messages, or instantly when you ask the AI to remember something.</div>';
    }
    html += `<div class="mem-meta">Last updated: ${data.lastUpdated ? formatDate(data.lastUpdated) : "Never"} · Total extractions: ${data.totalExtractions || 0}</div>`;
    document.getElementById("mem-modal-facts").innerHTML = html;
  } catch (e) {
    document.getElementById("mem-modal-facts").innerHTML =
      `<div class="empty-state" style="color:var(--danger)">Failed to load memory: ${escHtml(e.message)}</div>`;
  }
}

// Create project
document.getElementById("btn-create-project")?.addEventListener("click", () => {
  const panel = document.getElementById("proj-create-panel");
  if (panel) panel.style.display = (panel.style.display === "none" || !panel.style.display) ? "" : "none";
});
document.getElementById("btn-proj-create-cancel")?.addEventListener("click", () => {
  const panel = document.getElementById("proj-create-panel");
  if (panel) panel.style.display = "none";
});
document.getElementById("btn-proj-create-submit")?.addEventListener("click", async () => {
  const name = document.getElementById("proj-create-name")?.value.trim() || "";
  const btn  = document.getElementById("btn-proj-create-submit");
  btn.disabled = true; btn.textContent = "Creating...";
  try {
    await api.createProject(name);
    toast("Project created!", "success");
    document.getElementById("proj-create-panel").style.display = "none";
    document.getElementById("proj-create-name").value = "";
    loadProjects();
  } catch (e) { toast("Failed: " + e.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "Create Project"; }
});

// Memory modal close
document.getElementById("btn-close-memory-modal")?.addEventListener("click", () => {
  document.getElementById("modal-overlay").style.display = "none";
  document.getElementById("modal-memory").style.display  = "none";
  activeProjectId = null;
});
document.getElementById("btn-mem-modal-close")?.addEventListener("click", () => {
  document.getElementById("modal-overlay").style.display = "none";
  document.getElementById("modal-memory").style.display  = "none";
  activeProjectId = null;
});

// Clear memory
document.getElementById("btn-clear-memory")?.addEventListener("click", async () => {
  if (!activeProjectId) return;
  if (!confirm("Wipe ALL memory for this project? This cannot be undone.")) return;
  try {
    await api.clearProjectMemory(activeProjectId);
    toast("Project memory cleared.", "success");
    openMemoryModal(activeProjectId);
  } catch (e) { toast("Failed: " + e.message, "error"); }
});

// ═══════════════════════════════════════════════════════════
//  FINE TUNE — Per-agent manual memory management
// ═══════════════════════════════════════════════════════════
const FT_AGENTS = [
  { key: "universal", label: "🌐 Universal" },
  { key: "ceo",        label: "CEO" },
  { key: "cfo",        label: "CFO" },
  { key: "sales",      label: "Sales" },
  { key: "support",    label: "Support" },
  { key: "research",   label: "Research" },
  { key: "marketing",  label: "Marketing" },
  { key: "legal",      label: "Legal" },
];

let ftProjectId   = null;
let ftActiveTab   = "universal";
let ftAllFacts    = [];

function ftScopeOf(fact) {
  if (!fact.scope || fact.scope === "universal") return "universal";
  return fact.scope.startsWith("agent:") ? fact.scope.slice(6) : fact.scope;
}

async function loadFineTune() {
  const projSel = document.getElementById("ft-project-select");
  const scopeSel = document.getElementById("ft-scope-select");
  if (!projSel) return;

  // Ensure projects are loaded before reading state.projects — loadProjects()
  // populates state.projects but isn't guaranteed to have run/finished yet
  // if the user navigates here without visiting Projects/Keys/Playground first.
  if (!state.projects.length) {
    projSel.innerHTML = '<option value="">Loading projects…</option>';
    await loadProjects();
  }

  // Populate project dropdown
  const prevVal = projSel.value;
  projSel.innerHTML = state.projects.length
    ? state.projects.map(p => `<option value="${escHtml(p.projectId)}">${escHtml(p.name)}</option>`).join("")
    : '<option value="">No projects yet</option>';
  if (prevVal && state.projects.some(p => p.projectId === prevVal)) projSel.value = prevVal;

  // Populate scope dropdown in the "Add Fact" panel (universal + each agent)
  if (scopeSel) {
    scopeSel.innerHTML = FT_AGENTS.map(a =>
      `<option value="${a.key}">${a.key === "universal" ? a.label + " (all agents)" : "🤖 " + a.label + " only"}</option>`
    ).join("");
  }

  ftProjectId = projSel.value || null;
  if (!ftProjectId) {
    document.getElementById("ft-facts-list").innerHTML =
      '<div class="empty-state" style="padding:2rem">Create a project first to start fine-tuning agent memory.</div>';
    document.getElementById("ft-agent-tabs").innerHTML = "";
    return;
  }

  await ftLoadFacts();
}

async function ftLoadFacts() {
  const factsList = document.getElementById("ft-facts-list");
  factsList.innerHTML = Array.from({ length: 4 }).map(() => `
    <div class="ft-fact-skeleton">
      <div class="ft-skel-text"></div>
      <div class="ft-skel-badge"></div>
    </div>
  `).join("");

  try {
    const data = await api.getProjectMemory(ftProjectId);
    ftAllFacts = data.facts || [];
    ftRenderTabs();
    ftRenderFacts();
  } catch (e) {
    factsList.innerHTML = `<div class="empty-state" style="color:var(--danger)">Failed to load memory: ${escHtml(e.message)}</div>`;
  }
}

function ftRenderTabs() {
  const tabsEl = document.getElementById("ft-agent-tabs");
  if (!tabsEl) return;

  const counts = {};
  ftAllFacts.forEach(f => {
    const s = ftScopeOf(f);
    counts[s] = (counts[s] || 0) + 1;
  });

  tabsEl.innerHTML = FT_AGENTS.map(a => `
    <button class="ft-tab ${ftActiveTab === a.key ? "active" : ""}" data-ft-tab="${a.key}">
      ${a.label}<span class="ft-tab-count">${counts[a.key] || 0}</span>
    </button>
  `).join("");

  tabsEl.querySelectorAll("[data-ft-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      ftActiveTab = btn.dataset.ftTab;
      ftRenderTabs();
      ftRenderFacts();
    });
  });
}

function ftRenderFacts() {
  const factsList = document.getElementById("ft-facts-list");
  const filtered = ftAllFacts.filter(f => ftScopeOf(f) === ftActiveTab);

  if (filtered.length === 0) {
    factsList.innerHTML = `<div class="empty-state" style="padding:2rem">No facts yet for ${escHtml(FT_AGENTS.find(a => a.key === ftActiveTab)?.label || ftActiveTab)}. Add one above.</div>`;
    return;
  }

  factsList.innerHTML = filtered.map((f, i) => {
    const vis = f.visibility === "public" ? "public" : "internal";
    return `
      <div class="ft-fact-item" style="animation-delay:${i * 30}ms">
        <span class="ft-fact-text">${escHtml(f.fact)}</span>
        <div class="ft-fact-meta">
          <span class="ft-badge ${vis === "public" ? "ft-badge-public" : "ft-badge-internal"}">${vis === "public" ? "🌍 public" : "🔒 internal"}</span>
          ${f.manual ? '<span class="ft-badge ft-badge-manual">manual</span>' : ""}
          <button class="ft-fact-delete" data-ft-delete-fact="${escHtml(f.fact)}" data-ft-delete-scope="${escHtml(f.scope || "universal")}" title="Delete fact">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>`;
  }).join("");

  factsList.querySelectorAll("[data-ft-delete-fact]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const fact  = btn.dataset.ftDeleteFact;
      const scope = btn.dataset.ftDeleteScope;
      if (!confirm("Delete this fact? This cannot be undone.")) return;
      try {
        await api.deleteMemoryFact(ftProjectId, fact, scope);
        toast("Fact deleted.", "success");
        await ftLoadFacts();
      } catch (e) { toast("Failed: " + e.message, "error"); }
    });
  });
}

document.getElementById("ft-project-select")?.addEventListener("change", (e) => {
  ftProjectId = e.target.value || null;
  ftActiveTab = "universal";
  if (ftProjectId) ftLoadFacts();
});

document.getElementById("btn-ft-add-fact")?.addEventListener("click", async () => {
  const factInput = document.getElementById("ft-fact-input");
  const scopeSel  = document.getElementById("ft-scope-select");
  const visSel    = document.getElementById("ft-visibility-select");
  const btn       = document.getElementById("btn-ft-add-fact");

  const fact = factInput.value.trim();
  if (!fact) { toast("Enter a fact first.", "error"); return; }
  if (!ftProjectId) { toast("Select a project first.", "error"); return; }

  const scopeVal = scopeSel.value === "universal" ? "universal" : `agent:${scopeSel.value}`;
  const visVal   = visSel.value;

  btn.disabled = true; btn.textContent = "Adding...";
  try {
    const res = await api.addMemoryFact(ftProjectId, fact, scopeVal, visVal);
    if (res.duplicate) {
      toast("That fact already exists in this scope.", "info");
    } else {
      toast("Fact added.", "success");
      factInput.value = "";
      ftActiveTab = scopeSel.value; // jump to the tab it was added under
      await ftLoadFacts();
    }
  } catch (e) {
    toast("Failed: " + e.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Add Fact";
  }
});

// ═══════════════════════════════════════════════════════════
let pgConversationId = null;
let pgCurrentMessages = [];   // in-memory log of current conversation
let _pgRestoring      = false; // guard: don't re-save during restore

// ── localStorage conversation store ──────────────────────────────
const PG_STORE_KEY = "aldo_pg_conversations";
const PG_MAX_STORED = 20; // keep last 20 conversations

function pgLoadStore() {
  try { return JSON.parse(localStorage.getItem(PG_STORE_KEY) || "[]"); }
  catch { return []; }
}

function pgSaveStore(convs) {
  try { localStorage.setItem(PG_STORE_KEY, JSON.stringify(convs.slice(0, PG_MAX_STORED))); }
  catch { /* storage full, ignore */ }
}

function pgTimeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000)    return "just now";
  if (diff < 3600000)  return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
  return `${Math.floor(diff/86400000)}d ago`;
}

function pgUpsertConversation(convId, firstMsg, keyName, keyPrefix) {
  const store = pgLoadStore();
  const existing = store.find(c => c.id === convId);
  if (existing) {
    existing.updatedAt = new Date().toISOString();
    existing.msgCount  = (existing.msgCount || 0) + 1;
    pgSaveStore(store);
  } else {
    store.unshift({
      id:         convId,
      title:      firstMsg.slice(0, 60),
      keyName:    keyName || "Unknown key",
      keyPrefix:  keyPrefix || "",
      startedAt:  new Date().toISOString(),
      updatedAt:  new Date().toISOString(),
      msgCount:   1,
      messages:   [],  // stored separately for restore
    });
    pgSaveStore(store);
  }
}

function pgStoreMessages(convId, messages) {
  try {
    localStorage.setItem(`aldo_pg_msgs_${convId}`, JSON.stringify(messages.slice(-40)));
  } catch { /* storage full */ }
}

function pgLoadMessages(convId) {
  try {
    return JSON.parse(localStorage.getItem(`aldo_pg_msgs_${convId}`) || "[]");
  } catch { return []; }
}

function pgDeleteConversation(convId) {
  const store = pgLoadStore().filter(c => c.id !== convId);
  pgSaveStore(store);
  try { localStorage.removeItem(`aldo_pg_msgs_${convId}`); } catch { /* ignore */ }
}

const PLAYGROUND_MODELS = {
  gemini:    [
    { id: "", name: "Default (gemini-3.5-flash)" },
    { id: "gemini-3.5-flash",      name: "Gemini 3.5 Flash" },
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" },
    { id: "gemini-2.5-pro",        name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash",      name: "Gemini 2.5 Flash" },
    { id: "gemma-4-31b-it",        name: "Gemma 4 31B" },
    { id: "gemma-4-12b-it",        name: "Gemma 4 12B" },
  ],
  openai:    [
    { id: "", name: "Default (gpt-5.4-mini)" },
    { id: "gpt-5.5",       name: "GPT-5.5" },
    { id: "gpt-5.4",       name: "GPT-5.4" },
    { id: "gpt-5.4-pro",   name: "GPT-5.4 Pro" },
    { id: "gpt-5.4-mini",  name: "GPT-5.4 Mini" },
    { id: "gpt-5.4-nano",  name: "GPT-5.4 Nano" },
  ],
  anthropic: [
    { id: "", name: "Default (claude-sonnet-4-6)" },
    { id: "claude-opus-4-8",   name: "Claude Opus 4.8" },
    { id: "claude-opus-4-7",   name: "Claude Opus 4.7" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4-5",  name: "Claude Haiku 4.5" },
  ],
};

function populatePgKeyDropdown() {
  const sel = document.getElementById("pg-key-select");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">— Select a key —</option>';
  state.keys.forEach((k, i) => {
    const opt = document.createElement("option");
    opt.value       = i;  // index into state.keys
    opt.textContent = `${k.name} (${k.prefix}•••)`;
    sel.appendChild(opt);
  });
  if (prev !== "") sel.value = prev;
}

function updatePgMemoryChip(key) {
  const chip   = document.getElementById("pg-memory-chip");
  const inner  = document.getElementById("pg-memory-chip-inner");
  const dot    = document.getElementById("pg-memory-dot");
  const label  = document.getElementById("pg-memory-label");
  const info   = document.getElementById("pg-key-info");
  const prefix = document.getElementById("pg-key-prefix-display");
  if (!chip) return;
  if (!key) { chip.style.display = "none"; if(info) info.style.display="none"; return; }
  // Show prefix
  if (info && prefix) {
    prefix.textContent = key.prefix + "••••••••••";
    info.style.display = "";
  }
  // Find project
  const proj = key.projectId ? state.projects.find(p => p.projectId === key.projectId) : null;
  chip.style.display = "";
  if (proj && proj.memoryEnabled && !key.isPlaygroundKey) {
    // Non-playground key: project has memory, but Playground blocks it for this key type
    inner.className   = "proj-memory-status memory-off";
    dot.textContent   = "🚫";
    label.textContent = `Memory blocked in Playground — non-playground key`;
  } else if (proj && proj.memoryEnabled) {
    inner.className   = "proj-memory-status memory-on";
    dot.textContent   = "🟢";
    label.textContent = `Memory ON — ${proj.name}`;
  } else if (proj) {
    inner.className   = "proj-memory-status memory-off";
    dot.textContent   = "⚫";
    label.textContent = `Memory OFF — ${proj.name}`;
  } else if (key.isPlaygroundKey) {
    inner.className   = "proj-memory-status memory-off";
    dot.textContent   = "🎮";
    label.textContent = "Playground key — no project linked";
  } else {
    inner.className   = "proj-memory-status memory-off";
    dot.textContent   = "⚫";
    label.textContent = "No project — memory inactive";
  }
}


function renderPgHistory() {
  const list = document.getElementById("pg-history-list");
  if (!list) return;
  const store = pgLoadStore();

  if (!store.length) {
    list.innerHTML = '<div class="pg-history-empty">No conversations yet.<br>Send a message to start.</div>';
    return;
  }

  list.innerHTML = store.map(c => {
    const isActive = c.id === pgConversationId;
    const ago      = pgTimeAgo(c.updatedAt);
    return `
      <div class="pg-history-item ${isActive ? 'active' : ''}" data-conv-id="${escAttr(c.id)}" role="button" tabindex="0" title="${escAttr(c.title)}">
        <div class="pg-history-item-body">
          <div class="pg-history-item-title">${escHtml(c.title)}</div>
          <div class="pg-history-item-meta">
            <span>${ago}</span>
            <span class="pg-history-item-key">${escHtml(c.keyPrefix)}···</span>
          </div>
        </div>
        <button class="pg-history-item-del" data-del-conv-id="${escAttr(c.id)}" title="Delete conversation" aria-label="Delete conversation">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`;
  }).join("");

  // Click to restore conversation
  list.querySelectorAll(".pg-history-item[data-conv-id]").forEach(item => {
    item.addEventListener("click", (e) => {
      if (e.target.closest("[data-del-conv-id]")) return; // don't restore if delete clicked
      const convId = item.dataset.convId;
      pgRestoreConversation(convId);
    });
    // Also support Enter/Space keyboard activation
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pgRestoreConversation(item.dataset.convId);
      }
    });
  });

  // Delete conversation
  list.querySelectorAll(".pg-history-item-del[data-del-conv-id]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const convId = btn.dataset.delConvId;
      if (convId === pgConversationId) {
        // If deleting active, start fresh
        pgConversationId = null;
        document.getElementById("pg-conv-wrap").style.display = "none";
        resetPgMessages();
        pgCurrentMessages = [];
      }
      pgDeleteConversation(convId);
      renderPgHistory();
    });
  });
}

function pgRestoreConversation(convId) {
  const store = pgLoadStore();
  const conv  = store.find(c => c.id === convId);
  if (!conv) return;

  pgConversationId  = convId;
  pgCurrentMessages = []; // will be filled during restore
  document.getElementById("pg-conv-wrap").style.display = "";
  document.getElementById("pg-conv-id").textContent = convId.slice(0, 16) + "...";

  const msgs      = pgLoadMessages(convId);
  const container = document.getElementById("playground-messages");
  if (!container) return;

  if (msgs.length === 0) {
    resetPgMessages();
  } else {
    container.innerHTML = '';
    _pgRestoring = true;
    msgs.forEach(m => appendPgMessage(m.role, m.content, m.meta || {}));
    _pgRestoring = false;
    // Rebuild pgCurrentMessages from stored data so new messages append correctly
    pgCurrentMessages = msgs.map(m => ({ role: m.role, content: m.content, meta: m.meta || {} }));
  }

  renderPgHistory();
  toast("Conversation restored", "info");
}

async function loadPlayground() {
  updateSnippet("curl");
  populatePgModels("gemini");
  if (!state.keys.length) {
    try {
      const data = await api.listApiKeys();
      state.keys = data.keys || [];
    } catch {
      // leave state.keys as-is
    }
  }
  populatePgKeyDropdown();

  // NOTE: intentionally no auto-restore of the last conversation here.
  // Auto-restoring on every load/reload caused pgConversationId to silently
  // stick to the previous conversation, so subsequent messages kept merging
  // into it instead of starting a new conversation. History items are
  // restorable explicitly by clicking them (see renderPgHistory click handler).

  renderPgHistory();
}

function pgEscapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function pgFormatContent(text) {
  let html = pgEscapeHtml(text);
  html = html.replace(/```([\s\S]*?)```/g, (m, code) =>
    `<pre style="background:var(--bg-elevated);border:1px solid var(--border);padding:var(--space-3);border-radius:var(--radius-md);overflow-x:auto;margin:var(--space-2) 0;"><code>${code}</code></pre>`
  );
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

function appendPgMessage(role, content, meta = {}) {
  const container = document.getElementById("playground-messages");
  if (!container) return;

  const wrap = document.createElement("div");
  wrap.className = `chat-message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "chat-avatar";
  avatar.innerHTML = role === "user"
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;

  const contentEl = document.createElement("div");
  contentEl.className = "chat-content";
  if (meta.isError) {
    contentEl.style.borderColor = "var(--danger, #e5484d)";
    contentEl.style.color = "var(--danger, #e5484d)";
  }

  let html = "";
  if (meta.thinking) {
    html += `<details style="margin-bottom:var(--space-2);font-size:0.85em;opacity:0.75;">
      <summary style="cursor:pointer;">Thinking process</summary>
      <div style="padding:var(--space-2);margin-top:4px;background:rgba(127,127,127,0.1);border-radius:var(--radius-sm);">${pgFormatContent(meta.thinking)}</div>
    </details>`;
  }
  html += `<div>${pgFormatContent(content)}</div>`;
  if (role === "agent" && !meta.isError && (meta.agent || meta.model)) {
    const parts = [];
    if (meta.agent) parts.push(escHtml(meta.agent.toUpperCase()));
    if (meta.model) parts.push(escHtml(meta.model));
    if (meta.tokens) parts.push(`${escHtml(String(meta.tokens))} tokens`);
    if (meta.elapsed) parts.push(`${escHtml(String(meta.elapsed))}ms`);
    html += `<div style="margin-top:var(--space-2);font-size:0.75rem;opacity:0.6;">${parts.join(" · ")}</div>`;
  }
  contentEl.innerHTML = html;

  wrap.appendChild(avatar);
  wrap.appendChild(contentEl);
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;

  // Track message in-memory (batch-saved after each exchange — see send handler)
  if (!_pgRestoring) {
    pgCurrentMessages.push({ role, content, meta: { agent: meta.agent, model: meta.model, tokens: meta.tokens, elapsed: meta.elapsed } });
  }
}

let pgTypingInterval = null;

function showPgTyping() {
  const container = document.getElementById("playground-messages");
  if (!container) return null;

  const wrap = document.createElement("div");
  wrap.className = "chat-message agent";
  wrap.id = "pg-typing-indicator";

  const avatar = document.createElement("div");
  avatar.className = "chat-avatar";
  avatar.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;

  const contentEl = document.createElement("div");
  contentEl.className = "chat-content";
  contentEl.innerHTML = `<span id="pg-typing-dots">·</span>`;

  wrap.appendChild(avatar);
  wrap.appendChild(contentEl);
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;

  let dots = 1;
  pgTypingInterval = setInterval(() => {
    dots = (dots % 3) + 1;
    const dotsEl = document.getElementById("pg-typing-dots");
    if (dotsEl) dotsEl.textContent = ".".repeat(dots);
  }, 350);

  return wrap;
}

function removePgTyping(el) {
  if (pgTypingInterval) {
    clearInterval(pgTypingInterval);
    pgTypingInterval = null;
  }
  (el || document.getElementById("pg-typing-indicator"))?.remove();
}

function resetPgMessages() {
  const container = document.getElementById("playground-messages");
  if (!container) return;
  container.innerHTML = `
    <div class="chat-message agent">
      <div class="chat-avatar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
      </div>
      <div class="chat-content">
        <p>Welcome to the Aeldorado Playground.</p>
        <p>I am your AI Orchestrator. Provide your API key and password in the sidebar, and send a message below to begin.</p>
      </div>
    </div>`;
}

function populatePgModels(provider) {
  const modelSel = document.getElementById("pg-model");
  const models = PLAYGROUND_MODELS[provider] || PLAYGROUND_MODELS.gemini;
  modelSel.innerHTML = models.map(m => `<option value="${m.id}">${m.name}</option>`).join("");
}

function updateSnippet(lang) {
  const code = document.getElementById("snippet-code");
  const snippets = {
    curl: `curl -X POST https://api.aeldorado.solanacy.in/v1/chat \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer aldo-live-YOUR_KEY" \\
  -H "X-Encryption-Password: YOUR_PASSWORD" \\
  -d '{
    "message": "Analyze our Q2 revenue trends",
    "provider": "gemini",
    "model": "gemini-3.5-flash"
  }'`,
    python: `import requests

response = requests.post(
    "https://api.aeldorado.solanacy.in/v1/chat",
    headers={
        "Authorization": "Bearer aldo-live-YOUR_KEY",
        "X-Encryption-Password": "YOUR_PASSWORD",
    },
    json={
        "message": "Analyze our Q2 revenue trends",
        "provider": "gemini",
        "model": "gemini-3.5-flash",
    }
)
print(response.json())`,
    javascript: `const response = await fetch(
  "https://api.aeldorado.solanacy.in/v1/chat",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer aldo-live-YOUR_KEY",
      "X-Encryption-Password": "YOUR_PASSWORD",
    },
    body: JSON.stringify({
      message: "Analyze our Q2 revenue trends",
      provider: "gemini",
      model: "gemini-3.5-flash",
    }),
  }
);
const data = await response.json();
console.log(data);`,
  };
  code.textContent = snippets[lang] || snippets.curl;
}

// ═══════════════════════════════════════════════════════════
//  DOCS
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
//  DOCS
//  Single source of truth: docs.html (public). The in-app
//  /app/:uid/docs view embeds that exact file via iframe, so
//  any edit to docs.html is reflected everywhere automatically.
// ═══════════════════════════════════════════════════════════
function loadDocs() {
  const el = document.getElementById("docs-content");
  if (el.dataset.loaded === "1") return; // avoid re-creating iframe on repeat nav
  el.innerHTML = `<iframe src="/docs.html" title="Aeldorado Documentation" style="width:100%;height:100%;min-height:calc(100vh - 32px);border:none;display:block;"></iframe>`;
  el.dataset.loaded = "1";
}

// ═══════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════
function escHtml(s) { return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;").replace(/`/g,"&#x60;"); }
function escAttr(s) { return (s||"").replace(/'/g,"\\'").replace(/"/g,'\\"').replace(/`/g,"\\`"); }

// ═══════════════════════════════════════════════════════════
//  EVENT BINDINGS
// ═══════════════════════════════════════════════════════════
function bindEvents() {
  // ── Sidebar nav (SPA — no full page reload) ─────────────────────────────
  // Links carry real /app/{uid}/{page} hrefs (set in onAuthStateChanged) so
  // right-click → open in new tab and bookmarking still work normally.
  // But a plain left-click should navigate client-side via pushState +
  // handleRoute(), same as navigateTo() elsewhere, so each section's data
  // still reloads fresh (showView already calls loadKeys/loadBilling/etc.)
  // without a full document reload.
  document.addEventListener("click", (e) => {
    const link = e.target.closest(".sidebar-link[data-nav]");
    if (!link || !link.getAttribute("href")) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; // let modified clicks behave normally
    e.preventDefault();
    navigateTo(link.getAttribute("href"));
  });

  // ── Mobile hamburger ───────────────
  document.getElementById("btn-mobile-menu")?.addEventListener("click", () => {
    document.querySelector(".sidebar")?.classList.toggle("open");
    document.getElementById("sidebar-overlay")?.classList.toggle("visible");
  });
  document.getElementById("sidebar-overlay")?.addEventListener("click", () => {
    document.querySelector(".sidebar")?.classList.remove("open");
    document.getElementById("sidebar-overlay")?.classList.remove("visible");
  });

  // ── Sidebar collapse (desktop) ─────
  document.getElementById("btn-sidebar-collapse")?.addEventListener("click", () => {
    const sidebar = document.querySelector(".sidebar");
    const layout  = document.querySelector(".dashboard-layout");
    const collapsed = sidebar?.classList.toggle("collapsed");
    layout?.classList.toggle("sidebar-collapsed", collapsed);
    try { localStorage.setItem("aeldorado_sidebar_collapsed", collapsed ? "1" : "0"); } catch {}
    const btn = document.getElementById("btn-sidebar-collapse");
    if (btn) btn.setAttribute("title", collapsed ? "Expand sidebar" : "Collapse sidebar");
  });

  // Restore collapsed state from previous session
  try {
    if (localStorage.getItem("aeldorado_sidebar_collapsed") === "1") {
      document.querySelector(".sidebar")?.classList.add("collapsed");
      document.querySelector(".dashboard-layout")?.classList.add("sidebar-collapsed");
      const btn = document.getElementById("btn-sidebar-collapse");
      if (btn) btn.setAttribute("title", "Expand sidebar");
    }
  } catch {}

  // ── Landing nav ────────────────────
  document.getElementById("btn-nav-signin")?.addEventListener("click", () => navigateTo("/login"));
  document.getElementById("btn-nav-start")?.addEventListener("click", () => navigateTo("/login"));
  document.getElementById("btn-hero-start")?.addEventListener("click", () => navigateTo("/login"));

  // ── Auth ───────────────────────────
  document.getElementById("btn-google-signin")?.addEventListener("click", async () => {
    try { await signInWithGoogle(); toast("Signed in with Google!", "success"); }
    catch (e) { if (e.code !== "auth/popup-closed-by-user") toast("Google sign-in failed: " + e.message, "error"); }
  });

  document.getElementById("form-email-auth")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    if (!email || !password) return toast("Fill in all fields.", "error");
    try {
      if (state.isSignUp) { await signUpWithEmail(email, password); toast("Account created!", "success"); }
      else { await signInWithEmail(email, password); toast("Welcome back!", "success"); }
    } catch (e) {
      const msgs = {
        "auth/email-already-in-use": "Email already registered.",
        "auth/invalid-credential": "Invalid email or password.",
        "auth/weak-password": "Password must be at least 6 characters.",
      };
      toast(msgs[e.code] || e.message, "error");
    }
  });

  const tabLogin = document.getElementById("tab-login");
  const tabRegister = document.getElementById("tab-register");
  const authTabs = document.querySelector(".auth-tabs");
  const formWindow = document.querySelector(".auth-form-window");
  const authName = document.getElementById("auth-name");

  function switchTab(isReg) {
    state.isSignUp = isReg;
    if(isReg) {
      tabRegister.classList.add("active");
      tabLogin.classList.remove("active");
      authTabs.classList.add("is-register");
      authName.style.display = "block";
      setTimeout(() => { authName.style.opacity = "1"; authName.style.transform = "translateX(0)"; }, 10);
      document.querySelector("#form-email-auth button[type='submit']").textContent = "Create Account";
      formWindow.style.transform = "scale(1.02)";
      setTimeout(() => formWindow.style.transform = "scale(1)", 200);
    } else {
      tabLogin.classList.add("active");
      tabRegister.classList.remove("active");
      authTabs.classList.remove("is-register");
      authName.style.opacity = "0"; authName.style.transform = "translateX(-20px)";
      setTimeout(() => { authName.style.display = "none"; }, 300);
      document.querySelector("#form-email-auth button[type='submit']").textContent = "Sign In";
      formWindow.style.transform = "scale(0.98)";
      setTimeout(() => formWindow.style.transform = "scale(1)", 200);
    }
  }

  tabLogin?.addEventListener("click", () => switchTab(false));
  tabRegister?.addEventListener("click", () => switchTab(true));

  // ── Sign out ───────────────────────
  document.getElementById("btn-signout")?.addEventListener("click", async () => {
    await signOutUser(); toast("Signed out.", "info"); navigateTo("/");
  });

  // ── Sidebar nav ────────────────────
  document.getElementById("pg-key-select")?.addEventListener("change", (e) => {
    const idx = parseInt(e.target.value);
    const key = isNaN(idx) ? null : state.keys[idx];
    updatePgMemoryChip(key);
  });

  // ── Playground Send (REAL API call) ─────────────
  document.getElementById("btn-pg-send")?.addEventListener("click", async () => {
    const agent    = document.getElementById("pg-agent").value;
    const msgInput = document.getElementById("pg-message");
    const message  = msgInput.value.trim();
    const password = document.getElementById("pg-password").value;
    const provider = document.getElementById("pg-provider").value;
    const model    = document.getElementById("pg-model").value || null;

    // Get key from dropdown
    const keyIdx = parseInt(document.getElementById("pg-key-select")?.value);
    const keyObj = isNaN(keyIdx) ? null : state.keys[keyIdx];
    let apiKey = keyObj?.rawKey || "";

    // rawKey may be null in list response — fetch via reveal endpoint if needed
    if (!apiKey && keyObj?.prefix) {
      try {
        const revealed = await api.revealApiKey(keyObj.prefix);
        apiKey = revealed.rawKey || "";
        keyObj.rawKey = apiKey; // cache for this session
      } catch { /* leave empty, toast below handles it */ }
    }

    const btn = document.getElementById("btn-pg-send");

    if (!message)  return toast("Message is required.", "error");
    if (!apiKey)   return toast("Select an API key from the dropdown.", "error");
    if (!password) return toast("Enter your vault encryption password.", "error");

    appendPgMessage("user", message);
    msgInput.value = "";
    msgInput.style.height = "auto";

    btn.disabled = true;
    const typingEl = showPgTyping();

    const start = Date.now();
    try {
      const path = agent === "chat" ? "/v1/chat" : `/v1/agent/${agent}`;
      const body = { message, provider };
      if (model)             body.model           = model;
      if (pgConversationId)  body.conversation_id = pgConversationId;

      const { API_BASE } = await import("./config.js");
      const res = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: {
          "Content-Type":          "application/json",
          "Authorization":         `Bearer ${apiKey}`,
          "X-Encryption-Password": password,
          "X-Aeldorado-Source":    "playground",
        },
        body: JSON.stringify(body),
      });

      const elapsed = Date.now() - start;
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error?.message || data.error?.detail || `HTTP ${res.status}`);
      }

      // Save conversation id for multi-turn
      if (data.conversation_id) {
        const isNew = !pgConversationId;
        pgConversationId = data.conversation_id;
        document.getElementById("pg-conv-wrap").style.display = "";
        document.getElementById("pg-conv-id").textContent = pgConversationId.slice(0, 16) + "...";
        // Upsert history entry
        pgUpsertConversation(
          pgConversationId,
          message,
          keyObj?.name || "",
          keyObj?.prefix || ""
        );
      }

      // Memory extraction toast
      if (data.memory?.extracted === "triggered") {
        const projName = keyObj?.projectId
          ? (state.projects.find(p => p.projectId === keyObj.projectId)?.name || "project")
          : "project";
        setTimeout(() => toast(`🧠 Memory snapshot saved for "${projName}"`, "success"), 500);
      }

      const content   = data.response?.content || data.response?.summary || data.response || "";
      const thinking  = data.response?.thinking || null;
      const agentUsed = data.agent || agent || "ceo";
      const modelUsed = data.model || model || "";
      const tokUsage  = data.usage?.tokens;
      const tokTotal  = tokUsage?.total || (tokUsage?.input || 0) + (tokUsage?.output || 0) || 0;

      removePgTyping(typingEl);
      appendPgMessage("agent", typeof content === "string" ? content : JSON.stringify(content, null, 2), {
        thinking,
        agent: agentUsed,
        model: modelUsed,
        elapsed,
        tokens: tokTotal,
      });

      // Persist messages AFTER agent response is appended (both user + agent are now in pgCurrentMessages)
      if (pgConversationId) {
        pgStoreMessages(pgConversationId, pgCurrentMessages);
        renderPgHistory();
      }

      toast("Response received!", "success");

    } catch (e) {
      removePgTyping(typingEl);
      appendPgMessage("agent", `Error: ${e.message}`, { isError: true });
      toast("Error: " + e.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
  // ── Playground Provider → Model sync ──────────────
  document.getElementById("pg-provider")?.addEventListener("change", (e) => {
    populatePgModels(e.target.value);
  });

  const pgMsgInput = document.getElementById("pg-message");
  if (pgMsgInput) {
    pgMsgInput.addEventListener("input", function() {
      this.style.height = "auto";
      this.style.height = Math.min(this.scrollHeight, 200) + "px";
    });
    // Enter to send, Shift+Enter for newline
    pgMsgInput.addEventListener("keydown", function(e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        document.getElementById("btn-pg-send")?.click();
      }
    });
  }
  // ── New Conversation ───────────────────────────────
  document.getElementById("btn-pg-new-conv")?.addEventListener("click", () => {
    pgConversationId  = null;
    pgCurrentMessages = [];
    document.getElementById("pg-conv-wrap").style.display = "none";
    document.getElementById("pg-conv-id").textContent = "—";
    resetPgMessages();
    renderPgHistory();
    toast("New conversation started.", "info");
  });

  document.getElementById("btn-vault-store")?.addEventListener("click", async () => {
    const apiKey = document.getElementById("vault-apikey").value.trim();
    const password = document.getElementById("vault-password").value;
    const model = document.getElementById("vault-model")?.value;
    const btn = document.getElementById("btn-vault-store");
    if (!apiKey) return toast("Enter your API key.", "error");
    if (!password) return toast("Enter an encryption password.", "error");
    if (password.length < 8) return toast("Password must be at least 8 characters.", "error");
    btn.disabled = true;
    btn.querySelector(".vsb-text").textContent = "Encrypting...";
    try {
      const data = await api.storeVaultKey(apiKey, password, null, model);
      toast(data.message || "Key encrypted and stored!", "success");
      document.getElementById("vault-apikey").value = "";
      document.getElementById("vault-password").value = "";
      // Reset strength bar
      const fill = document.getElementById("vault-pw-fill");
      const label = document.getElementById("vault-pw-label");
      const strengthWrap = document.getElementById("vault-pw-strength");
      if (fill) { fill.className = "pw-strength-fill"; }
      if (label) { label.className = "pw-strength-label"; label.textContent = ""; }
      if (strengthWrap) strengthWrap.style.display = "none";
      // Reset provider detect chip
      const chip = document.getElementById("vault-provider-detect");
      if (chip) chip.style.display = "none";
      const wrap = document.getElementById("vault-key-wrap");
      if (wrap) wrap.className = "vgp-input-wrap";
      loadVault();
    } catch (e) { toast("Failed: " + e.message, "error"); }
    finally {
      btn.disabled = false;
      btn.querySelector(".vsb-text").textContent = "Encrypt & Store";
    }
  });

  // ── Vault: eye toggle buttons ────────────────────────────
  function setupEyeToggle(eyeBtnId, inputId) {
    const btn = document.getElementById(eyeBtnId);
    const input = document.getElementById(inputId);
    if (!btn || !input) return;
    btn.addEventListener("click", () => {
      const isHidden = input.type === "password";
      input.type = isHidden ? "text" : "password";
      btn.querySelector(".eye-open").style.display  = isHidden ? "none"  : "";
      btn.querySelector(".eye-closed").style.display = isHidden ? ""     : "none";
    });
  }
  setupEyeToggle("vault-key-eye", "vault-apikey");
  setupEyeToggle("vault-pw-eye",  "vault-password");

  // ── Vault: live password strength meter ──────────────────
  document.getElementById("vault-password")?.addEventListener("input", (e) => {
    const pw = e.target.value;
    const strengthWrap = document.getElementById("vault-pw-strength");
    const fill   = document.getElementById("vault-pw-fill");
    const label  = document.getElementById("vault-pw-label");
    if (!strengthWrap || !fill || !label) return;

    if (!pw) {
      strengthWrap.style.display = "none";
      return;
    }
    strengthWrap.style.display = "flex";

    // Simple strength calc
    let score = 0;
    if (pw.length >= 8)  score++;
    if (pw.length >= 12) score++;
    if (/[A-Z]/.test(pw)) score++;
    if (/[0-9]/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;

    const levels = [
      { cls: "weak",   text: "Weak" },
      { cls: "weak",   text: "Weak" },
      { cls: "fair",   text: "Fair" },
      { cls: "good",   text: "Good" },
      { cls: "strong", text: "Strong" },
      { cls: "strong", text: "Strong" },
    ];
    const lvl = levels[Math.min(score, 5)];
    fill.className  = `pw-strength-fill ${lvl.cls}`;
    label.className = `pw-strength-label ${lvl.cls}`;
    label.textContent = lvl.text;
  });

  // ── Vault: provider pill active highlight on auto-detect ─
  const vaultKeyInput = document.getElementById("vault-apikey");
  if (vaultKeyInput) {
    vaultKeyInput.addEventListener("input", () => {
      // Clear all active pills first
      document.querySelectorAll(".vault-provider-pill").forEach(p => p.classList.remove("active"));
      // Rely on existing detectProvider logic — it writes to vault-provider-name
      // We watch the detect chip visibility to update pills
      setTimeout(() => {
        const chip = document.getElementById("vault-provider-detect");
        const nameEl = document.getElementById("vault-provider-name");
        const wrap = document.getElementById("vault-key-wrap");
        if (chip && chip.style.display !== "none" && nameEl) {
          const detected = nameEl.textContent.toLowerCase();
          document.querySelectorAll(".vault-provider-pill").forEach(p => {
            if (p.dataset.provider && detected.includes(p.dataset.provider)) {
              p.classList.add("active");
            }
          });
          if (wrap) wrap.className = "vgp-input-wrap success";
        } else {
          if (wrap) wrap.className = "vgp-input-wrap";
        }
      }, 80);
    });
  }

  // ── IP Allowlist ───────────────────
  document.getElementById("btn-save-ip")?.addEventListener("click", async () => {
    const raw = document.getElementById("ip-allowlist-input").value.trim();
    const ips = raw ? raw.split("\n").map(s => s.trim()).filter(Boolean) : [];
    try {
      await api.updateIPAllowlist(ips);
      toast(`IP allowlist updated (${ips.length} IPs).`, "success");
      document.getElementById("ip-count").textContent = ips.length === 0 ? "All IPs allowed" : `${ips.length} IP(s) allowlisted`;
    } catch (e) { toast("Failed: " + e.message, "error"); }
  });

  document.querySelectorAll(".snippet-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".snippet-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active"); updateSnippet(tab.dataset.lang);
    });
  });

  // ── History API routing ───────────────────
  window.addEventListener("popstate", handleRoute);

  // Intercept all clicks on internal auth/landing links
  document.body.addEventListener("click", e => {
    const a = e.target.closest("a");
    if (a) {
      const href = a.getAttribute("href");
      if (href === "#landing" || href === "/") {
        e.preventDefault(); navigateTo("/");
      } else if (href === "#auth" || href === "/login") {
        e.preventDefault(); navigateTo("/login");
      }
    }
  });

// Mobile Menu Toggle — handled inside bindEvents() above (do not duplicate)

  // ── Resize chart ───────────────────
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.analytics) renderAnalyticsChart(state.analytics);
    }, 250);
  });
}

// ═══════════════════════════════════════════════════════════
//  BILLING — Subscription Management
// ═══════════════════════════════════════════════════════════

const PLAN_ICONS = {
  free:          '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  starter:       '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
  growth:        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  pro:           '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  enterprise_t1: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="22" height="16" rx="2"/><path d="M1 10h22"/><path d="M7 6V4a2 2 0 012-2h6a2 2 0 012 2v2"/></svg>',
  enterprise_t2: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
  developer:     '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><line x1="14" y1="4" x2="10" y2="20"/></svg>',
};

const PLAN_POPULAR = "growth"; // Badge shown on this plan

let billingData = null; // Cached billing status
let pendingOrderPlan = null; // Plan selected in payment modal

async function loadBilling() {
  const view = document.getElementById("view-billing");
  if (!view) return;
  view.innerHTML = `
    <div class="billing-current-card-skeleton">
      <div class="billing-skel-icon"></div>
      <div class="billing-skel-info">
        <div class="billing-skel-cell w-title"></div>
        <div class="billing-skel-cell w-subtitle"></div>
      </div>
      <div class="billing-skel-price">
        <div class="billing-skel-cell w-amount"></div>
      </div>
    </div>
    <div class="billing-section-title">Available Plans</div>
    <div class="billing-plans-grid">
      ${Array.from({ length: 3 }).map((_, i) => `
        <div class="plan-card-skeleton" style="animation-delay:${i * 60}ms">
          <div class="billing-skel-icon" style="width:38px;height:38px;border-radius:11px"></div>
          <div class="billing-skel-cell w-title" style="height:14px"></div>
          <div class="billing-skel-cell w-amount" style="height:22px;width:70px"></div>
          <div class="billing-skel-cell w-line"></div>
          <div class="billing-skel-cell w-line"></div>
          <div class="billing-skel-cell w-line"></div>
          <div class="billing-skel-cell w-btn"></div>
        </div>
      `).join("")}
    </div>
  `;

  try {
    billingData = await getBillingStatus();
    renderBilling(billingData);

    // Check if we're returning from Cashfree payment
    const urlParams = new URLSearchParams(window.location.search);
    const returnOrderId = urlParams.get("order_id");
    if (returnOrderId) {
      // Clean URL
      window.history.replaceState(null, "", window.location.pathname);
      await handlePaymentReturn(returnOrderId);
    }
  } catch (e) {
    view.innerHTML = `<div class="empty-state" style="color:var(--danger)">Failed to load billing: ${escHtml(e.message)}</div>`;
  }
}

function renderBilling(data) {
  const view = document.getElementById("view-billing");
  if (!view) return;

  const plans        = data.plans || [];
  const currentTier  = data.tier || "free";
  const tierName     = data.tierName || "Free";
  const isActivated  = data.freeActivated;
  const expiry       = data.subscriptionExpiry;
  const price        = data.price || 0;
  const billingDays  = data.billingDays;

  // ── Activation banner for unactivated users
  const showBanner = (currentTier === "free" && !isActivated);

  // ── Format expiry
  const expiryText = expiry
    ? `Renews ${new Date(expiry).toLocaleDateString("en-IN", { day:"numeric", month:"short", year:"numeric" })}`
    : (currentTier === "free" && isActivated ? "Active — no expiry" : "");

  // ── Current plan price display
  const priceDisplay = price === 0
    ? (currentTier === "free" ? "₹0" : "₹0")
    : `₹${price.toLocaleString()}`;

  view.innerHTML = `
    ${ showBanner ? `
    <div class="billing-activation-banner">
      <div class="ban-icon">⚡</div>
      <div class="ban-content">
        <h3>Activate Your Free Plan</h3>
        <p>A one-time ₹1 charge verifies your account and unlocks your free tier (80 calls/5 hours).</p>
      </div>
      <div class="ban-action">
        <button class="plan-card-btn btn-activate" id="btn-banner-activate">Activate for ₹1</button>
      </div>
    </div>` : "" }

    <div class="billing-current-card">
      <div class="cur-icon">${PLAN_ICONS[currentTier] || '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>'}</div>
      <div class="cur-info">
        <h2>${escHtml(tierName)} Plan</h2>
        <div class="cur-subtitle">${billingDays ? `${billingDays}-day subscription` : (currentTier === "free" ? "Free forever after activation" : "No expiry")}</div>
        ${expiryText ? `<div class="cur-expiry">📅 ${expiryText}</div>` : ""}
      </div>
      <div class="cur-price">
        <div class="price-amount">${priceDisplay}</div>
        <span class="price-cycle">${billingDays ? `/ ${billingDays} days` : ""}</span>
      </div>
    </div>

    <div class="billing-section-title">Available Plans</div>

    <div class="billing-plans-grid" id="billing-plans-grid">
      ${plans.map((p, i) => renderPlanCard(p, currentTier, isActivated, i)).join("")}
    </div>

    <div class="billing-section-title">Payment History</div>
    <div id="billing-history-container">
      <div class="billing-history-skeleton-wrap">
        ${Array.from({ length: 3 }).map(() => `
          <div class="billing-history-skeleton-row">
            <div class="billing-history-skeleton-cell w-date"></div>
            <div class="billing-history-skeleton-cell w-plan"></div>
            <div class="billing-history-skeleton-cell w-amount"></div>
            <div class="billing-history-skeleton-cell w-txn"></div>
            <div class="billing-history-skeleton-cell w-status"></div>
          </div>
        `).join("")}
      </div>
    </div>
  `;

  // Bind plan card buttons
  view.querySelectorAll(".plan-card-btn[data-plan]").forEach(btn => {
    btn.addEventListener("click", () => openBillingModal(btn.dataset.plan, plans));
  });

  // Banner activate button
  document.getElementById("btn-banner-activate")?.addEventListener("click", () => {
    openBillingModal("free", plans);
  });

  // Load billing history async (reset pagination to page 1 each time the view loads)
  billingHistoryCursorStack = [null];
  loadBillingHistory(0);
}

function renderPlanCard(plan, currentTier, isActivated, index) {
  const isActive   = plan.id === currentTier;
  const isPopular  = plan.id === PLAN_POPULAR;
  const needsActivation = plan.id === "free" && !isActivated;

  let btnClass = "btn-upgrade";
  let btnText  = "Upgrade";
  if (isActive && plan.id !== "free") {
    btnClass = "btn-current"; btnText = "Current Plan";
  } else if (isActive && plan.id === "free" && isActivated) {
    btnClass = "btn-current"; btnText = "Active";
  } else if (needsActivation) {
    btnClass = "btn-activate"; btnText = "Activate for ₹1";
  }

  const priceDisplay = plan.id === "free"
    ? `<div class="plan-card-price"><span class="plan-price-currency">₹</span><span class="plan-price-amount">0</span></div>
       <div class="plan-price-onetime">₹1 one-time activation</div>`
    : `<div class="plan-card-price">
        <span class="plan-price-currency">₹</span>
        <span class="plan-price-amount">${plan.price.toLocaleString()}</span>
        <span class="plan-price-cycle">/ ${plan.billingDays} days</span>
       </div>`;

  const limits = plan.limits;
  const fmt = v => v === "unlimited" ? "Unlimited" : parseInt(v).toLocaleString();

  return `
    <div class="plan-card${isActive ? " plan-active" : ""}${isPopular && !isActive ? " plan-popular" : ""}" style="animation-delay:${index * 60}ms">
      ${isActive  ? '<span class="plan-active-badge">Current</span>' : ""}
      ${isPopular && !isActive ? '<span class="plan-popular-badge">Popular</span>' : ""}
      <div class="plan-card-header">
        <div class="plan-card-icon plan-icon-${plan.id === "enterprise_t1" || plan.id === "enterprise_t2" ? "enterprise" : plan.id}">
          ${PLAN_ICONS[plan.id] || '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>'}
        </div>
        <div>
          <div class="plan-card-name">${escHtml(plan.name)}</div>
          <div class="plan-card-cycle">${plan.billingDays ? `${plan.billingDays}-day cycle` : "One-time activation"}</div>
        </div>
      </div>
      ${priceDisplay}
      <ul class="plan-card-limits">
        <li>${fmt(limits.daily)} calls / 5 hours</li>
        <li>${fmt(limits.weekly)} calls / week</li>
        <li>${fmt(limits.monthly)} calls / 28 days</li>
      </ul>
      <button class="plan-card-btn ${btnClass}" data-plan="${plan.id}" ${isActive && btnClass === "btn-current" ? "disabled" : ""}>
        ${btnText}
      </button>
    </div>`;
}

// ── Payment History (cursor-paginated, same pattern as Request Logs) ────────
const PG_BILLING_HISTORY_PAGE_SIZE = 3;
let billingHistoryCursorStack = [null]; // cursorStack[i] = cursor used to fetch page i
let billingHistoryPageIndex = 0;
let billingHistoryHasMore = false;
let billingHistoryLoading = false;
let billingHistoryRows = [];

async function loadBillingHistory(targetPage = 0) {
  if (billingHistoryLoading) return;
  billingHistoryLoading = true;
  const container = document.getElementById("billing-history-container");
  if (!container) { billingHistoryLoading = false; return; }

  container.innerHTML = `
    <div class="billing-history-skeleton-wrap">
      ${Array.from({ length: 3 }).map(() => `
        <div class="billing-history-skeleton-row">
          <div class="billing-history-skeleton-cell w-date"></div>
          <div class="billing-history-skeleton-cell w-plan"></div>
          <div class="billing-history-skeleton-cell w-amount"></div>
          <div class="billing-history-skeleton-cell w-txn"></div>
          <div class="billing-history-skeleton-cell w-status"></div>
        </div>
      `).join("")}
    </div>`;

  try {
    const cursor = billingHistoryCursorStack[targetPage] || null;
    const data = await getBillingHistory(PG_BILLING_HISTORY_PAGE_SIZE, cursor);
    billingHistoryRows = data.history || [];
    billingHistoryHasMore = !!data.hasMore;
    billingHistoryPageIndex = targetPage;

    // Remember the cursor for the *next* page — same cursor-stack approach
    // as Request Logs, avoids re-fetching pages already paid for.
    if (billingHistoryHasMore && data.nextCursor) {
      billingHistoryCursorStack[targetPage + 1] = data.nextCursor;
    }
    renderBillingHistory();
  } catch (e) {
    container.innerHTML = `<div class="billing-history-wrap"><div class="empty-state" style="padding:1.5rem">Couldn't load payment history.</div></div>`;
  } finally {
    billingHistoryLoading = false;
  }
}

function renderBillingHistory() {
  const container = document.getElementById("billing-history-container");
  if (!container) return;

  if (!billingHistoryRows.length && billingHistoryPageIndex === 0) {
    container.innerHTML = `
      <div class="billing-history-wrap">
        <table>
          <thead><tr><th>Date</th><th>Plan</th><th>Amount</th><th>Transaction ID</th><th>Status</th></tr></thead>
          <tbody>
            <tr><td colspan="5" style="text-align:center;color:rgba(255,255,255,0.35);padding:1.5rem">No payment history yet.</td></tr>
          </tbody>
        </table>
      </div>`;
    return;
  }

  const hasPrev = billingHistoryPageIndex > 0;
  const hasNext = billingHistoryHasMore;

  container.innerHTML = `
    <div class="billing-history-wrap">
      <table>
        <thead>
          <tr><th>Date</th><th>Plan</th><th>Amount</th><th>Transaction ID</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${billingHistoryRows.map(row => `
            <tr>
              <td>${row.date ? formatDate(row.date) : "—"}</td>
              <td>${escHtml(row.planName || row.plan || "—")}</td>
              <td>₹${(row.amount || 0).toLocaleString("en-IN")}</td>
              <td class="billing-history-txn">${row.transactionId ? escHtml(row.transactionId) : "—"}</td>
              <td>
                <span class="billing-badge-${row.status === "paid" ? "paid" : "failed"}">
                  ${row.status === "paid" ? "✓ Paid" : "✕ Failed"}
                </span>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <div class="billing-history-pagination">
      <button class="billing-history-page-btn" id="billing-history-prev-btn" ${hasPrev ? "" : "disabled"}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>
        Prev
      </button>
      <span class="billing-history-page-indicator">Page ${billingHistoryPageIndex + 1}</span>
      <button class="billing-history-page-btn" id="billing-history-next-btn" ${hasNext ? "" : "disabled"}>
        Next
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
    </div>
  `;

  document.getElementById("billing-history-prev-btn")?.addEventListener("click", () => {
    if (billingHistoryPageIndex > 0) loadBillingHistory(billingHistoryPageIndex - 1);
  });
  document.getElementById("billing-history-next-btn")?.addEventListener("click", () => {
    if (billingHistoryHasMore) loadBillingHistory(billingHistoryPageIndex + 1);
  });
}

// ── Billing Payment Modal ─────────────────────────────────────────────────

function openBillingModal(planId, plans) {
  const plan = (plans || billingData?.plans || []).find(p => p.id === planId);
  if (!plan) return;

  pendingOrderPlan = planId;

  const isFreePlan = planId === "free";
  const amount     = isFreePlan ? plan.activationFee || 1 : plan.price;
  const cycleText  = isFreePlan ? "One-time activation" : `Every ${plan.billingDays} days`;

  const modal   = document.getElementById("modal-billing");
  const overlay = document.getElementById("modal-overlay");
  if (!modal || !overlay) return;

  document.getElementById("billing-modal-plan-name").textContent  = plan.name;
  document.getElementById("billing-modal-plan-cycle").textContent = cycleText;
  document.getElementById("billing-modal-plan-price").textContent = `₹${amount.toLocaleString()}`;
  document.getElementById("billing-modal-note").textContent       = isFreePlan
    ? "This ₹1 charge is a one-time account verification fee. Your free plan will be active immediately after payment."
    : `You'll be charged ₹${amount} now. Access lasts ${plan.billingDays} days from payment date.`;

  const payBtn = document.getElementById("btn-pay-now");
  payBtn.textContent = isFreePlan ? "Pay ₹1 & Activate" : `Pay ₹${amount.toLocaleString()}`;
  payBtn.className   = `plan-card-btn ${isFreePlan ? "btn-activate-style" : "btn-upgrade"}`;
  payBtn.id          = "btn-pay-now";
  payBtn.disabled    = false;

  overlay.style.display  = "flex";
  modal.style.display    = "block";
}

document.getElementById("btn-pay-now")?.addEventListener("click", async () => {
  const plan  = pendingOrderPlan;
  const btn   = document.getElementById("btn-pay-now");
  if (!plan || !btn) return;

  btn.disabled    = true;
  btn.textContent = "Creating order...";

  try {
    const order = await createOrder(plan);

    // Close modal
    document.getElementById("modal-overlay").style.display = "none";
    document.getElementById("modal-billing").style.display = "none";

    // Load Cashfree checkout
    if (!window.Cashfree) {
      toast("Payment SDK not loaded. Please refresh.", "error");
      btn.disabled = false;
      return;
    }

    const cashfree = window.Cashfree({ mode: "production" });
    const checkoutOptions = {
      paymentSessionId: order.paymentSessionId,
      redirectTarget:   "_modal",
    };

    cashfree.checkout(checkoutOptions).then(async result => {
      if (result.error) {
        toast("Payment failed: " + result.error.message, "error");
        return;
      }
      if (result.paymentDetails) {
        toast("Verifying payment...", "info");
        await handlePaymentReturn(order.orderId);
      }
    });

  } catch (e) {
    toast("Failed to create order: " + e.message, "error");
    btn.disabled    = false;
    btn.textContent = "Try again";
  }
});

document.getElementById("btn-billing-modal-cancel")?.addEventListener("click", () => {
  document.getElementById("modal-overlay").style.display  = "none";
  document.getElementById("modal-billing").style.display  = "none";
  pendingOrderPlan = null;
});

async function handlePaymentReturn(orderId) {
  try {
    const result = await verifyPayment(orderId);
    if (result.paid) {
      toast(`🎉 ${result.planName || "Plan"} activated successfully!`, "success");
      // Reload billing view to reflect new tier
      billingData = null;
      await loadBilling();
      // Update sidebar tier badge
      const tierEl = document.getElementById("user-tier");
      if (tierEl) tierEl.textContent = result.planName || "Free";
    } else {
      toast("Payment pending. Please try again or check your bank.", "error");
    }
  } catch (e) {
    toast("Could not verify payment: " + e.message, "error");
  }
}

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════
async function init() {
  bindEvents();
  await initAuth(onAuthStateChanged);
}

init().catch(e => { console.error("[INIT]", e); hideLoader(); toast("Init failed: " + e.message, "error"); });

// js/app.js — Admin Portal App Logic
// Aeldorado by Solanacy Technologies

import { initAuth, signInWithGoogle, signOutAndRedirect, verifyAdminAccess, getUser } from "./auth.js";
import { adminApi } from "./api.js";

const loginScreen = document.getElementById("login-screen");
const adminShell   = document.getElementById("admin-shell");
const loginBtn     = document.getElementById("login-btn");
const loginError   = document.getElementById("login-error");
const identityEl   = document.getElementById("admin-identity");
const signoutBtn    = document.getElementById("signout-btn");
const statusRail    = document.getElementById("status-rail");

// Assignable tiers (excludes "developer" — strictly email-gated server-side)
const ASSIGNABLE_TIERS = [
  { id: "free",          name: "Free" },
  { id: "starter",       name: "Starter" },
  { id: "growth",        name: "Growth" },
  { id: "pro",           name: "Pro" },
  { id: "enterprise_t1", name: "Enterprise T1" },
  { id: "enterprise_t2", name: "Enterprise T2" },
];

loginBtn.addEventListener("click", async () => {
  loginError.classList.remove("visible");
  loginBtn.disabled = true;
  loginBtn.textContent = "Signing in…";
  try {
    await signInWithGoogle();
    await boot();
  } catch (e) {
    loginError.textContent = "Sign-in failed. Try again.";
    loginError.classList.add("visible");
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Continue with Google";
  }
});

signoutBtn.addEventListener("click", () => signOutAndRedirect());

// ── View Routing ─────────────────────────────────────────────
const views = ["overview", "users", "user-detail", "broadcasts", "newsroom", "newsroom-editor", "logs", "access-log"];
let currentUsersCursor = null;
let currentUsersSearch = "";
let currentLogsCursor = null;
let currentUserDetailUid = null;
let currentRevenueRange = "this_month";

function showView(name, opts = {}) {
  views.forEach((v) => {
    document.getElementById(`view-${v}`).classList.toggle("active", v === name);
  });
  // Nav items only exist for top-level views, not user-detail / newsroom-editor
  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });

  if (name === "overview") loadOverview();
  if (name === "users") loadUsers({ reset: true });
  if (name === "user-detail") loadUserDetail(opts.uid);
  if (name === "broadcasts") loadBroadcastsView();
  if (name === "newsroom") loadNewsroomView();
  if (name === "newsroom-editor") loadNewsroomEditor(opts.slug);
  if (name === "logs") loadLogs({ reset: true });
  if (name === "access-log") loadAccessLog();
}

document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});

document.getElementById("back-to-users").addEventListener("click", () => showView("users"));
document.getElementById("back-to-newsroom").addEventListener("click", () => showView("newsroom"));

// ── Overview ─────────────────────────────────────────────────
const REVENUE_RANGES = [
  { id: "today",      label: "Today" },
  { id: "yesterday",  label: "Yesterday" },
  { id: "this_week",  label: "This week" },
  { id: "last_week",  label: "Last week" },
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "all_time",   label: "All time" },
];

async function loadOverview() {
  const el = document.getElementById("view-overview");
  el.innerHTML = `<div class="main-header"><div class="main-title">Overview</div><div class="main-sub">Live snapshot across all users and today's traffic.</div></div>${skelStatGrid(5)}${skelTable(6, 4)}`;
  try {
    const [data, errorsData] = await Promise.all([
      adminApi.overview(),
      adminApi.recentErrors({ limit: 20 }).catch(() => ({ errors: [] })),
    ]);

    const hasErrors = data.today.errors > 0;
    statusRail.classList.toggle("has-errors", hasErrors);

    const tierChips = Object.entries(data.tierCounts)
      .map(([tier, count]) => `<span class="tier-chip"><b>${count}</b> ${escapeHtml(tier)}</span>`)
      .join("");

    const errors = errorsData.errors || [];
    const errorsSection = `
      <div class="main-header" style="margin-top:var(--space-8);">
        <div class="main-title" style="font-size:1.1rem;">Recent errors</div>
        <div class="main-sub">Last ${errors.length} failed requests across all users.</div>
      </div>
      ${errors.length ? `
        <table class="studio-table">
          <thead><tr><th>Time</th><th>Agent</th><th>Model</th><th>Provider</th><th>Error code</th></tr></thead>
          <tbody>
            ${errors.map((e) => `
              <tr>
                <td>${formatDate(e.timestamp)}</td>
                <td>${escapeHtml(e.agent || "—")}</td>
                <td>${escapeHtml(e.model || "—")}</td>
                <td>${escapeHtml(e.provider || "—")}</td>
                <td><span class="status-badge error">${escapeHtml(e.errorCode || "unknown")}</span></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      ` : `<div class="empty-state">No errors recently. Good.</div>`}
    `;

    el.innerHTML = `
      <div class="main-header">
        <div class="main-title">Overview</div>
        <div class="main-sub">Live snapshot across all users and today's traffic.</div>
      </div>
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">Total users</div>
          <div class="stat-value">${data.totalUsers}</div>
          <div class="tier-breakdown">${tierChips}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Requests today</div>
          <div class="stat-value">${data.today.requests}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Success today</div>
          <div class="stat-value success">${data.today.success}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Errors today</div>
          <div class="stat-value ${hasErrors ? "error" : ""}">${data.today.errors}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Tokens today</div>
          <div class="stat-value">${formatNumber(data.today.totalTokens)}</div>
        </div>
      </div>
      <div id="revenue-section"></div>
      ${errorsSection}
    `;

    renderRevenueSection(currentRevenueRange);
  } catch (e) {
    el.innerHTML = `<div class="error-state">Couldn't load overview: ${escapeHtml(e.message)}</div>`;
  }
}

async function renderRevenueSection(range) {
  const mount = document.getElementById("revenue-section");
  if (!mount) return;
  currentRevenueRange = range;

  const pillsHtml = `
    <div class="range-pills" style="display:flex;gap:var(--space-2);flex-wrap:wrap;margin:var(--space-3) 0 var(--space-4);">
      ${REVENUE_RANGES.map((r) => `
        <button type="button" class="range-pill${r.id === range ? " active" : ""}" data-range="${r.id}">${r.label}</button>
      `).join("")}
    </div>
  `;
  const header = `
    <div class="main-header" style="margin-top:var(--space-8);">
      <div class="main-title" style="font-size:1.1rem;">Revenue</div>
    </div>
  `;

  mount.innerHTML = `${header}${pillsHtml}${skelStatGrid(3)}${skelTable(4, 2)}`;
  bindRangePills(mount);

  try {
    const revenueData = await adminApi.revenue({ range });
    const rangeLabel = (REVENUE_RANGES.find((r) => r.id === range)?.label || range).toLowerCase();

    mount.innerHTML = `
      ${header}${pillsHtml}
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">MRR</div>
          <div class="stat-value">₹${formatNumber(revenueData.mrr)}</div>
          <div class="tier-breakdown"><span class="tier-chip">current snapshot</span></div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Paid (${rangeLabel})</div>
          <div class="stat-value success">₹${formatNumber(revenueData.paidInRange.total)}</div>
          <div class="tier-breakdown"><span class="tier-chip">${revenueData.paidInRange.orderCount} order${revenueData.paidInRange.orderCount === 1 ? "" : "s"}</span></div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Failed payments</div>
          <div class="stat-value ${revenueData.failedPayments.length ? "error" : ""}">${revenueData.failedPayments.length}</div>
          <div class="tier-breakdown"><span class="tier-chip">most recent, any time</span></div>
        </div>
      </div>
      ${revenueData.planBreakdown.length ? `
        <div class="breakdown-card" style="margin-top:var(--space-4);">
          <div class="breakdown-card-title">Plan breakdown — ${rangeLabel}</div>
          ${revenueData.planBreakdown.map((p) => `
            <div class="breakdown-row"><span>${escapeHtml(p.planName)} (${p.activeUsers} active${p.oneTime ? `, ${p.activationCount} activated × ₹${formatNumber(p.price)} one-time` : `, × ₹${formatNumber(p.price)}`})</span><span class="count">₹${formatNumber(p.monthlyRevenue)}</span></div>
          `).join("")}
        </div>
      ` : ""}
      ${revenueData.failedPayments.length ? `
        <div class="breakdown-card" style="margin-top:var(--space-4);">
          <div class="breakdown-card-title">Recent failed payments</div>
          <table class="studio-table">
            <thead><tr><th>Date</th><th>Plan</th><th>Amount</th><th>Reason</th></tr></thead>
            <tbody>
              ${revenueData.failedPayments.slice(0, 10).map((p) => `
                <tr>
                  <td>${formatDate(p.failedAt)}</td>
                  <td>${escapeHtml(p.planName)}</td>
                  <td>₹${formatNumber(p.amount)}</td>
                  <td>${escapeHtml(p.reason || "—")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : ""}
    `;
    bindRangePills(mount);
  } catch (e) {
    mount.innerHTML = `${header}${pillsHtml}<div class="empty-state">Failed to load revenue: ${escapeHtml(e.message)}</div>`;
    bindRangePills(mount);
  }
}

function bindRangePills(mount) {
  mount.querySelectorAll(".range-pill").forEach((btn) => {
    btn.addEventListener("click", () => renderRevenueSection(btn.dataset.range));
  });
}

// ── Broadcasts ───────────────────────────────────────────────
const BROADCAST_LEVELS = [
  { id: "info",     name: "Info" },
  { id: "warning",  name: "Warning" },
  { id: "critical", name: "Critical" },
];

async function loadBroadcastsView() {
  const el = document.getElementById("view-broadcasts");
  el.innerHTML = `
    <div class="main-header">
      <div class="main-title">Broadcasts</div>
      <div class="main-sub">Send a message to every logged-in user's dashboard.</div>
    </div>

    <div class="breakdown-card" style="margin-bottom:var(--space-6);">
      <div class="breakdown-card-title">New broadcast</div>
      <textarea class="studio-textarea" id="broadcast-message" placeholder="Message shown on every user's dashboard (max 500 characters)" maxlength="500"></textarea>
      <div class="filter-bar" style="margin-top:var(--space-3);margin-bottom:0;padding:0;background:transparent;border:none;">
        <select class="studio-select" id="broadcast-level" style="max-width:160px;">
          ${BROADCAST_LEVELS.map((l) => `<option value="${l.id}">${l.name}</option>`).join("")}
        </select>
        <input class="studio-input" id="broadcast-expiry" type="number" min="1" placeholder="Expires in hours (optional)" style="max-width:220px;" />
        <button class="btn btn-primary btn-sm" id="broadcast-send">Send broadcast</button>
      </div>
    </div>

    <div class="main-header" style="border-bottom:none;padding-bottom:0;margin-bottom:var(--space-4);">
      <div class="main-title" style="font-size:1.0625rem;">History</div>
    </div>
    <div id="broadcasts-table-wrap">${skelTable(4, 4)}</div>
  `;

  document.getElementById("broadcast-send").addEventListener("click", async () => {
    const btn = document.getElementById("broadcast-send");
    const message = document.getElementById("broadcast-message").value.trim();
    const level = document.getElementById("broadcast-level").value;
    const expiresInHours = document.getElementById("broadcast-expiry").value.trim();

    if (!message) {
      showToast("Message can't be empty.", "error");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      await adminApi.createBroadcast(message, level, expiresInHours ? Number(expiresInHours) : null);
      document.getElementById("broadcast-message").value = "";
      document.getElementById("broadcast-expiry").value = "";
      showToast("Broadcast sent.", "success");
      loadBroadcastsHistory();
    } catch (e) {
      showToast(`Couldn't send broadcast: ${e.message}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Send broadcast";
    }
  });

  loadBroadcastsHistory();
}

async function loadBroadcastsHistory() {
  const wrap = document.getElementById("broadcasts-table-wrap");
  if (!wrap) return;
  wrap.innerHTML = skelTable(4, 4);

  try {
    const data = await adminApi.broadcasts({ limit: 50 });
    if (!data.broadcasts.length) {
      wrap.innerHTML = `<div class="empty-state">No broadcasts sent yet.</div>`;
      return;
    }

    const rows = data.broadcasts.map((b) => {
      const isLive = b.active && (!b.expiresAt || new Date(b.expiresAt).getTime() > Date.now());
      return `
        <tr>
          <td>${formatDate(b.createdAt)}</td>
          <td>${levelBadge(b.level)}</td>
          <td style="max-width:360px;white-space:normal;">${escapeHtml(b.message)}</td>
          <td>${b.expiresAt ? formatDate(b.expiresAt) : "—"}</td>
          <td>${isLive ? `<span class="status-badge success">Live</span>` : `<span class="status-badge">Ended</span>`}</td>
          <td>
            ${isLive ? `<button class="link-btn" data-action="retract" data-id="${escapeHtml(b.id)}">Retract</button>` : "—"}
          </td>
        </tr>
      `;
    }).join("");

    wrap.innerHTML = `
      <table class="studio-table">
        <thead><tr><th>Sent</th><th>Level</th><th>Message</th><th>Expires</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    wrap.querySelectorAll('[data-action="retract"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Retracting…";
        try {
          await adminApi.deactivateBroadcast(btn.dataset.id);
          showToast("Broadcast retracted.", "success");
          loadBroadcastsHistory();
        } catch (e) {
          showToast(`Couldn't retract: ${e.message}`, "error");
          btn.disabled = false;
          btn.textContent = "Retract";
        }
      });
    });
  } catch (e) {
    wrap.innerHTML = `<div class="error-state">Couldn't load broadcasts: ${escapeHtml(e.message)}</div>`;
  }
}

// ── Newsroom (CMS) ───────────────────────────────────────────
const NEWS_CATEGORIES = ["Product", "Announcements", "Policy", "Engineering"];

function statusBadge(status) {
  return status === "published"
    ? `<span class="status-badge success">Published</span>`
    : `<span class="status-badge">Draft</span>`;
}

async function loadNewsroomView() {
  const el = document.getElementById("view-newsroom");
  el.innerHTML = `
    <div class="main-header">
      <div class="main-title">Newsroom</div>
      <div class="main-sub">Write and publish posts to the public /news page.</div>
    </div>

    <div class="filter-bar" style="margin-bottom:var(--space-4);">
      <button class="btn btn-primary btn-sm" id="news-new-post">+ New post</button>
    </div>

    <div id="newsroom-table-wrap">${skelTable(5, 4)}</div>
  `;

  document.getElementById("news-new-post").addEventListener("click", () => showView("newsroom-editor", { slug: null }));

  loadNewsroomList();
}

async function loadNewsroomList() {
  const wrap = document.getElementById("newsroom-table-wrap");
  if (!wrap) return;
  wrap.innerHTML = skelTable(5, 4);

  try {
    const data = await adminApi.newsList({ limit: 100 });
    if (!data.posts.length) {
      wrap.innerHTML = `<div class="empty-state">No posts yet. Click "New post" to write the first one.</div>`;
      return;
    }

    const rows = data.posts.map((p) => `
      <tr>
        <td style="max-width:320px;white-space:normal;"><strong>${escapeHtml(p.title)}</strong></td>
        <td>${escapeHtml(p.category)}</td>
        <td>${statusBadge(p.status)}</td>
        <td>${p.publishedAt ? formatDate(p.publishedAt) : "—"}</td>
        <td>${formatDate(p.updatedAt)}</td>
        <td>
          <button class="link-btn" data-action="edit" data-slug="${escapeHtml(p.slug)}">Edit</button>
          <button class="link-btn" data-action="delete" data-slug="${escapeHtml(p.slug)}" style="color:var(--error);margin-left:10px;">Delete</button>
        </td>
      </tr>
    `).join("");

    wrap.innerHTML = `
      <table class="studio-table">
        <thead><tr><th>Title</th><th>Category</th><th>Status</th><th>Published</th><th>Updated</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    wrap.querySelectorAll('[data-action="edit"]').forEach((btn) => {
      btn.addEventListener("click", () => showView("newsroom-editor", { slug: btn.dataset.slug }));
    });

    wrap.querySelectorAll('[data-action="delete"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(`Delete "${btn.closest("tr").querySelector("td").textContent.trim()}"? This can't be undone.`)) return;
        btn.disabled = true;
        try {
          await adminApi.newsDelete(btn.dataset.slug);
          showToast("Post deleted.", "success");
          loadNewsroomList();
        } catch (e) {
          showToast(`Couldn't delete: ${e.message}`, "error");
          btn.disabled = false;
        }
      });
    });
  } catch (e) {
    wrap.innerHTML = `<div class="error-state">Couldn't load posts: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadNewsroomEditor(slug) {
  const el = document.getElementById("view-newsroom-editor");
  const isEdit = !!slug;

  el.innerHTML = `
    <div class="main-header">
      <button class="btn btn-ghost btn-sm" id="back-to-newsroom">← Back to Newsroom</button>
      <div class="main-title" style="margin-top:var(--space-3);">${isEdit ? "Edit post" : "New post"}</div>
    </div>

    <div class="breakdown-card" style="margin-bottom:var(--space-4);">
      <input class="studio-input" id="news-title" placeholder="Post title" style="font-size:1.05rem;font-weight:600;margin-bottom:var(--space-3);" />

      <div class="filter-bar" style="padding:0;background:transparent;border:none;margin-bottom:var(--space-3);">
        <select class="studio-select" id="news-category" style="max-width:200px;">
          ${NEWS_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join("")}
        </select>
        <input class="studio-input" id="news-cover" placeholder="Cover image URL (optional)" style="flex:1;" />
      </div>

      <textarea class="studio-textarea" id="news-excerpt" placeholder="Short excerpt shown on the news list (max 280 chars)" maxlength="280" style="min-height:60px;margin-bottom:var(--space-3);"></textarea>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-4);">
        <div>
          <div class="main-sub" style="margin-bottom:6px;">Body (Markdown)</div>
          <textarea class="studio-textarea" id="news-body" placeholder="Write the post in Markdown…" style="min-height:420px;font-family:var(--font-mono);font-size:0.82rem;"></textarea>
        </div>
        <div>
          <div class="main-sub" style="margin-bottom:6px;">Preview</div>
          <div id="news-preview" style="min-height:420px;max-height:420px;overflow-y:auto;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;font-size:0.875rem;line-height:1.6;"></div>
        </div>
      </div>

      <div class="filter-bar" style="padding:0;background:transparent;border:none;margin-top:var(--space-4);justify-content:flex-end;">
        ${isEdit ? `<button class="btn btn-danger btn-sm" id="news-delete">Delete</button>` : ""}
        <button class="btn btn-outline btn-sm" id="news-save-draft">Save draft</button>
        <button class="btn btn-primary btn-sm" id="news-publish">Publish</button>
      </div>
    </div>
  `;

  document.getElementById("back-to-newsroom").addEventListener("click", () => showView("newsroom"));

  const titleEl = document.getElementById("news-title");
  const catEl = document.getElementById("news-category");
  const coverEl = document.getElementById("news-cover");
  const excerptEl = document.getElementById("news-excerpt");
  const bodyEl = document.getElementById("news-body");
  const previewEl = document.getElementById("news-preview");

  function renderPreview() {
    try {
      previewEl.innerHTML = window.marked ? window.marked.parse(bodyEl.value || "") : escapeHtml(bodyEl.value);
    } catch {
      previewEl.textContent = bodyEl.value;
    }
  }
  bodyEl.addEventListener("input", renderPreview);

  let currentStatus = "draft";

  if (isEdit) {
    try {
      const { post } = await adminApi.newsGet(slug);
      titleEl.value = post.title || "";
      catEl.value = post.category || "Announcements";
      coverEl.value = post.coverImage || "";
      excerptEl.value = post.excerpt || "";
      bodyEl.value = post.bodyMarkdown || "";
      currentStatus = post.status;
      renderPreview();
    } catch (e) {
      showToast(`Couldn't load post: ${e.message}`, "error");
      showView("newsroom");
      return;
    }
  }

  function collectFields() {
    return {
      title: titleEl.value.trim(),
      category: catEl.value,
      coverImage: coverEl.value.trim() || null,
      excerpt: excerptEl.value.trim(),
      bodyMarkdown: bodyEl.value,
    };
  }

  async function save(publish) {
    const fields = collectFields();
    if (!fields.title) {
      showToast("Title can't be empty.", "error");
      return;
    }

    const saveBtn = publish ? document.getElementById("news-publish") : document.getElementById("news-save-draft");
    saveBtn.disabled = true;
    const originalLabel = saveBtn.textContent;
    saveBtn.textContent = publish ? "Publishing…" : "Saving…";

    try {
      if (isEdit) {
        await adminApi.newsUpdate(slug, { ...fields, status: publish ? "published" : currentStatus });
      } else {
        await adminApi.newsCreate({ ...fields, publishNow: publish });
      }
      showToast(publish ? "Post published." : "Draft saved.", "success");
      showView("newsroom");
    } catch (e) {
      showToast(`Couldn't save: ${e.message}`, "error");
      saveBtn.disabled = false;
      saveBtn.textContent = originalLabel;
    }
  }

  document.getElementById("news-save-draft").addEventListener("click", () => save(false));
  document.getElementById("news-publish").addEventListener("click", () => save(true));

  if (isEdit) {
    document.getElementById("news-delete").addEventListener("click", async () => {
      if (!confirm(`Delete "${titleEl.value}"? This can't be undone.`)) return;
      try {
        await adminApi.newsDelete(slug);
        showToast("Post deleted.", "success");
        showView("newsroom");
      } catch (e) {
        showToast(`Couldn't delete: ${e.message}`, "error");
      }
    });
  }
}

function levelBadge(level) {
  const cls = level === "critical" ? "error" : level === "warning" ? "warning" : "";
  return `<span class="status-badge ${cls}">${escapeHtml(level || "info")}</span>`;
}

// ── Users ────────────────────────────────────────────────────
async function loadUsers({ reset = false, keepToolbar = false } = {}) {
  const el = document.getElementById("view-users");

  if (reset && !keepToolbar) {
    currentUsersCursor = null;
    el.innerHTML = `
      <div class="main-header">
        <div class="main-title">Users</div>
        <div class="main-sub">All registered accounts, newest first.</div>
      </div>
      <div class="filter-bar">
        <input class="studio-input" id="users-search-input" placeholder="Search by email…" value="${escapeHtml(currentUsersSearch)}" autocomplete="off" />
        <button class="btn btn-outline btn-sm" id="users-search-clear" style="${currentUsersSearch ? "" : "display:none;"}">Clear</button>
      </div>
      <div id="users-table-wrap">${skelTable(7, 7)}</div>
      <div class="load-more-wrap" id="users-load-more-wrap"></div>
    `;

    const searchInput = document.getElementById("users-search-input");
    const clearBtn = document.getElementById("users-search-clear");
    let searchDebounce = null;
    searchInput.addEventListener("input", (e) => {
      clearTimeout(searchDebounce);
      const val = e.target.value.trim();
      searchDebounce = setTimeout(() => {
        currentUsersSearch = val;
        clearBtn.style.display = val ? "" : "none";
        // Re-fetch results only — toolbar (and the input's focus) stays put.
        loadUsers({ reset: true, keepToolbar: true });
      }, 300);
    });
    clearBtn.addEventListener("click", () => {
      currentUsersSearch = "";
      searchInput.value = "";
      clearBtn.style.display = "none";
      loadUsers({ reset: true, keepToolbar: true });
    });
  } else if (reset && keepToolbar) {
    currentUsersCursor = null;
    document.getElementById("users-table-wrap").innerHTML = skelTable(7, 7);
    document.getElementById("users-load-more-wrap").innerHTML = "";
  }

  const wrap = document.getElementById("users-table-wrap");
  const loadMoreWrap = document.getElementById("users-load-more-wrap");

  try {
    const params = { limit: 25 };
    if (currentUsersCursor) params.cursor = currentUsersCursor;
    if (currentUsersSearch) params.search = currentUsersSearch;
    const data = await adminApi.users(params);

    if (!data.users.length && reset) {
      wrap.innerHTML = currentUsersSearch
        ? `<div class="empty-state">No users match "${escapeHtml(currentUsersSearch)}".</div>`
        : `<div class="empty-state">No users yet.</div>`;
      loadMoreWrap.innerHTML = "";
      return;
    }

    const rows = data.users.map((u) => `
      <tr>
        <td class="clickable" data-uid="${escapeHtml(u.uid)}">${escapeHtml(u.email || "—")}</td>
        <td>${escapeHtml(u.displayName || "—")}</td>
        <td>${renderTierBadge(u.tier, u.staleDeveloperTag)}</td>
        <td>${u.freeActivated ? "Yes" : "No"}</td>
        <td>${formatDate(u.lastLogin)}</td>
        <td>${u.suspended ? `<span class="status-badge error">Suspended</span>` : `<span class="status-badge success">Active</span>`}</td>
        <td>
          <div class="row-actions">
            <button class="link-btn" data-action="view" data-uid="${escapeHtml(u.uid)}">View</button>
            <button class="link-btn" data-action="tier" data-uid="${escapeHtml(u.uid)}" data-email="${escapeHtml(u.email || "")}" data-tier="${escapeHtml(u.tier)}">Change tier</button>
            <button class="link-btn" data-action="suspend" data-uid="${escapeHtml(u.uid)}" data-email="${escapeHtml(u.email || "")}" data-suspended="${u.suspended ? "1" : "0"}">${u.suspended ? "Unsuspend" : "Suspend"}</button>
            <button class="link-btn" data-action="logout" data-uid="${escapeHtml(u.uid)}" data-email="${escapeHtml(u.email || "")}">Force logout</button>
          </div>
        </td>
      </tr>
    `).join("");

    const tableHtml = `
      <table class="studio-table">
        <thead>
          <tr><th>Email</th><th>Name</th><th>Tier</th><th>Activated</th><th>Last login</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    if (reset) {
      wrap.innerHTML = tableHtml;
    } else {
      wrap.querySelector("tbody").insertAdjacentHTML("beforeend", rows);
    }

    currentUsersCursor = data.nextCursor;
    loadMoreWrap.innerHTML = data.nextCursor
      ? `<button class="btn btn-outline" id="users-load-more">Load more</button>`
      : "";

    if (data.nextCursor) {
      document.getElementById("users-load-more").addEventListener("click", (e) => {
        e.target.textContent = "Loading…";
        e.target.disabled = true;
        loadUsers({ reset: false });
      });
    }

    wireUserRowActions(wrap);
  } catch (e) {
    if (reset) wrap.innerHTML = `<div class="error-state">Couldn't load users: ${escapeHtml(e.message)}</div>`;
    else showToast(`Couldn't load more users: ${e.message}`, "error");
  }
}

function wireUserRowActions(scopeEl) {
  scopeEl.querySelectorAll("td.clickable[data-uid]").forEach((td) => {
    td.addEventListener("click", () => showView("user-detail", { uid: td.dataset.uid }));
  });

  scopeEl.querySelectorAll('[data-action="view"]').forEach((btn) => {
    btn.addEventListener("click", () => showView("user-detail", { uid: btn.dataset.uid }));
  });

  scopeEl.querySelectorAll('[data-action="tier"]').forEach((btn) => {
    btn.addEventListener("click", () => openTierModal(btn.dataset.uid, btn.dataset.email, btn.dataset.tier));
  });

  scopeEl.querySelectorAll('[data-action="suspend"]').forEach((btn) => {
    btn.addEventListener("click", () => openSuspendModal(btn.dataset.uid, btn.dataset.email, btn.dataset.suspended === "1"));
  });

  scopeEl.querySelectorAll('[data-action="logout"]').forEach((btn) => {
    btn.addEventListener("click", () => openForceLogoutModal(btn.dataset.uid, btn.dataset.email));
  });
}

// ── User Detail ──────────────────────────────────────────────
async function loadUserDetail(uid) {
  if (!uid) return showView("users");
  currentUserDetailUid = uid;

  const el = document.getElementById("view-user-detail");
  el.innerHTML = `
    <div class="main-header">
      <button class="btn btn-ghost btn-sm" id="back-to-users">← Back to users</button>
    </div>
    <div class="detail-header">
      <div style="display:flex;flex-direction:column;gap:var(--space-2);">
        <div class="skel skel-block" style="width:220px;height:18px;"></div>
        <div class="skel skel-block" style="width:150px;height:12px;"></div>
      </div>
    </div>
    ${skelStatGrid(5)}
  `;
  document.getElementById("back-to-users").addEventListener("click", () => showView("users"));

  try {
    const { user, usage } = await adminApi.userDetail(uid);

    el.innerHTML = `
      <div class="main-header">
        <button class="btn btn-ghost btn-sm" id="back-to-users">← Back to users</button>
      </div>

      <div class="detail-header">
        <div class="detail-identity">
          <div class="detail-email">${escapeHtml(user.email || "—")}</div>
          <div class="detail-uid">${escapeHtml(user.uid)}</div>
        </div>
        <div class="detail-actions">
          ${renderTierBadge(user.tier, user.staleDeveloperTag)}
          ${user.suspended ? `<span class="status-badge error">Suspended</span>` : `<span class="status-badge success">Active</span>`}
          <button class="btn btn-outline btn-sm" data-action="tier" data-uid="${escapeHtml(user.uid)}" data-email="${escapeHtml(user.email || "")}" data-tier="${escapeHtml(user.tier)}">Change tier</button>
          <button class="btn btn-outline btn-sm" data-action="suspend" data-uid="${escapeHtml(user.uid)}" data-email="${escapeHtml(user.email || "")}" data-suspended="${user.suspended ? "1" : "0"}">${user.suspended ? "Unsuspend" : "Suspend"}</button>
          <button class="btn btn-danger btn-sm" data-action="logout" data-uid="${escapeHtml(user.uid)}" data-email="${escapeHtml(user.email || "")}">Force logout</button>
        </div>
      </div>

      ${user.staleDeveloperTag ? `
        <div class="empty-state" style="margin-bottom:var(--space-4);text-align:left;padding:var(--space-4);border-color:rgba(253, 214, 99, 0.4);">
          <strong>tier:"developer" is stale.</strong> This account's email doesn't match the admin account, so the server already force-downgrades it to free on any real request. It's just leftover DB state.
          <div style="margin-top:var(--space-3);">
            <button class="btn btn-outline btn-sm" data-action="tier" data-uid="${escapeHtml(user.uid)}" data-email="${escapeHtml(user.email || "")}" data-tier="free">Set to free now</button>
          </div>
        </div>
      ` : ""}

      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">Calls (28d)</div>
          <div class="stat-value">${formatNumber(usage.totalCalls)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Tokens (28d)</div>
          <div class="stat-value">${formatNumber(usage.totalTokens)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Avg latency</div>
          <div class="stat-value">${formatNumber(usage.avgLatencyMs)}ms</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Error rate</div>
          <div class="stat-value ${usage.errorRate > 0 ? "error" : ""}">${usage.errorRate}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Active API keys</div>
          <div class="stat-value">${user.activeApiKeys} <span style="font-size:0.9rem;color:var(--text-muted)">/ ${user.totalApiKeys}</span></div>
        </div>
      </div>

      <div class="breakdown-grid">
        <div class="breakdown-card">
          <div class="breakdown-card-title">Agent usage (28d)</div>
          ${renderBreakdown(usage.agentBreakdown)}
        </div>
        <div class="breakdown-card">
          <div class="breakdown-card-title">Model usage (28d)</div>
          ${renderBreakdown(usage.modelBreakdown)}
        </div>
      </div>

      ${user.suspended ? `<div class="empty-state" style="margin-top:var(--space-6);text-align:left;padding:var(--space-4);">Suspended: ${escapeHtml(user.suspendedReason || "No reason given")} — ${formatDate(user.suspendedAt)}</div>` : ""}

      <div class="detail-tabs" style="margin-top:var(--space-8);">
        <button class="detail-tab active" data-tab="profile">Profile</button>
        <button class="detail-tab" data-tab="keys">API keys</button>
        <button class="detail-tab" data-tab="logs">Request logs</button>
        <button class="detail-tab" data-tab="payments">Payments</button>
      </div>

      <div class="detail-pane active" id="pane-profile">
        <table class="studio-table">
          <tbody>
            <tr><td style="color:var(--text-muted)">Display name</td><td>${escapeHtml(user.displayName || "—")}</td></tr>
            <tr><td style="color:var(--text-muted)">Free activated</td><td>${user.freeActivated ? "Yes" : "No"}</td></tr>
            <tr><td style="color:var(--text-muted)">Created</td><td>${formatDate(user.createdAt)}</td></tr>
            <tr><td style="color:var(--text-muted)">Last login</td><td>${formatDate(user.lastLogin)}</td></tr>
            <tr><td style="color:var(--text-muted)">Subscription expiry</td><td>${formatDate(user.subscriptionExpiry)}</td></tr>
            <tr><td style="color:var(--text-muted)">Last payment</td><td>${formatDate(user.lastPaymentAt)}</td></tr>
            <tr><td style="color:var(--text-muted)">Last order ID</td><td>${escapeHtml(user.lastOrderId || "—")}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="detail-pane" id="pane-keys">
        <div id="user-keys-wrap">${skelTable(3, 7)}</div>
      </div>

      <div class="detail-pane" id="pane-logs">
        <div id="user-logs-wrap">${skelTable(5, 6)}</div>
        <div class="load-more-wrap" id="user-logs-load-more-wrap"></div>
      </div>

      <div class="detail-pane" id="pane-payments">
        <div id="user-payments-wrap">${skelTable(4, 6)}</div>
        <div class="load-more-wrap" id="user-payments-load-more-wrap"></div>
      </div>
    `;

    document.getElementById("back-to-users").addEventListener("click", () => showView("users"));
    wireUserRowActions(el);

    // Tabs
    let logsLoaded = false;
    let paymentsLoaded = false;
    let keysLoaded = false;
    el.querySelectorAll(".detail-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        el.querySelectorAll(".detail-tab").forEach((t) => t.classList.toggle("active", t === tab));
        el.querySelectorAll(".detail-pane").forEach((p) => p.classList.toggle("active", p.id === `pane-${tab.dataset.tab}`));
        if (tab.dataset.tab === "logs" && !logsLoaded) {
          logsLoaded = true;
          loadUserLogs(uid, { reset: true });
        }
        if (tab.dataset.tab === "payments" && !paymentsLoaded) {
          paymentsLoaded = true;
          loadUserPayments(uid, { reset: true });
        }
        if (tab.dataset.tab === "keys" && !keysLoaded) {
          keysLoaded = true;
          loadUserKeys(uid);
        }
      });
    });
  } catch (e) {
    el.innerHTML = `
      <div class="main-header">
        <button class="btn btn-ghost btn-sm" id="back-to-users">← Back to users</button>
      </div>
      <div class="error-state">Couldn't load user: ${escapeHtml(e.message)}</div>
    `;
    document.getElementById("back-to-users").addEventListener("click", () => showView("users"));
  }
}

function renderBreakdown(obj) {
  const entries = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return `<div style="color:var(--text-muted);font-size:0.8125rem;">No activity yet.</div>`;
  return entries.map(([key, count]) => `
    <div class="breakdown-row"><span>${escapeHtml(key)}</span><span class="count">${formatNumber(count)}</span></div>
  `).join("");
}

let userLogsCursor = null;
async function loadUserLogs(uid, { reset = false } = {}) {
  const wrap = document.getElementById("user-logs-wrap");
  const loadMoreWrap = document.getElementById("user-logs-load-more-wrap");
  if (reset) userLogsCursor = null;

  try {
    const params = { limit: 25 };
    if (userLogsCursor) params.cursor = userLogsCursor;
    const data = await adminApi.userLogs(uid, params);

    if (!data.logs.length && reset) {
      wrap.innerHTML = `<div class="empty-state">No request logs yet.</div>`;
      loadMoreWrap.innerHTML = "";
      return;
    }

    const rows = data.logs.map((l) => `
      <tr>
        <td>${formatDate(l.timestamp)}</td>
        <td>${escapeHtml(l.agent)}</td>
        <td>${escapeHtml(l.model)}</td>
        <td>${escapeHtml(l.provider)}</td>
        <td>${l.status === "success" ? `<span class="status-badge success">success</span>` : `<span class="status-badge error">error</span>`}</td>
        <td>${formatNumber(l.tokens?.total)}</td>
        <td>${formatNumber(l.latencyMs)}ms</td>
      </tr>
    `).join("");

    const tableHtml = `
      <table class="studio-table">
        <thead><tr><th>Time</th><th>Agent</th><th>Model</th><th>Provider</th><th>Status</th><th>Tokens</th><th>Latency</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    if (reset) wrap.innerHTML = tableHtml;
    else wrap.querySelector("tbody").insertAdjacentHTML("beforeend", rows);

    userLogsCursor = data.nextCursor;
    loadMoreWrap.innerHTML = data.nextCursor ? `<button class="btn btn-outline" id="user-logs-load-more">Load more</button>` : "";
    if (data.nextCursor) {
      document.getElementById("user-logs-load-more").addEventListener("click", (e) => {
        e.target.textContent = "Loading…";
        e.target.disabled = true;
        loadUserLogs(uid, { reset: false });
      });
    }
  } catch (e) {
    if (reset) wrap.innerHTML = `<div class="error-state">Couldn't load logs: ${escapeHtml(e.message)}</div>`;
    else showToast(`Couldn't load more logs: ${e.message}`, "error");
  }
}

let userPaymentsCursor = null;
async function loadUserPayments(uid, { reset = false } = {}) {
  const wrap = document.getElementById("user-payments-wrap");
  const loadMoreWrap = document.getElementById("user-payments-load-more-wrap");
  if (reset) userPaymentsCursor = null;

  try {
    const params = { limit: 10 };
    if (userPaymentsCursor) params.cursor = userPaymentsCursor;
    const data = await adminApi.userPayments(uid, params);

    if (!data.payments.length && reset) {
      wrap.innerHTML = `<div class="empty-state">No payment history yet.</div>`;
      loadMoreWrap.innerHTML = "";
      return;
    }

    const rows = data.payments.map((p) => `
      <tr>
        <td>${formatDate(p.date)}</td>
        <td>${escapeHtml(p.planName)}</td>
        <td>₹${formatNumber(p.amount)}</td>
        <td>${p.status === "paid" ? `<span class="status-badge success">paid</span>` : `<span class="status-badge error">${escapeHtml(p.status)}</span>`}</td>
        <td>${escapeHtml(p.transactionId || "—")}</td>
        <td>${escapeHtml(p.orderId)}</td>
      </tr>
    `).join("");

    const tableHtml = `
      <table class="studio-table">
        <thead><tr><th>Date</th><th>Plan</th><th>Amount</th><th>Status</th><th>Transaction ID</th><th>Order ID</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    if (reset) wrap.innerHTML = tableHtml;
    else wrap.querySelector("tbody").insertAdjacentHTML("beforeend", rows);

    userPaymentsCursor = data.nextCursor;
    loadMoreWrap.innerHTML = data.nextCursor ? `<button class="btn btn-outline" id="user-payments-load-more">Load more</button>` : "";
    if (data.nextCursor) {
      document.getElementById("user-payments-load-more").addEventListener("click", (e) => {
        e.target.textContent = "Loading…";
        e.target.disabled = true;
        loadUserPayments(uid, { reset: false });
      });
    }
  } catch (e) {
    if (reset) wrap.innerHTML = `<div class="error-state">Couldn't load payments: ${escapeHtml(e.message)}</div>`;
    else showToast(`Couldn't load more payments: ${e.message}`, "error");
  }
}

// ── API Keys (per-user) ──────────────────────────────────────
async function loadUserKeys(uid) {
  const wrap = document.getElementById("user-keys-wrap");
  try {
    const data = await adminApi.userKeys(uid);

    if (!data.keys.length) {
      wrap.innerHTML = `<div class="empty-state">No API keys generated yet.</div>`;
      return;
    }

    const rows = data.keys.map((k) => `
      <tr>
        <td>${escapeHtml(k.name || "—")}</td>
        <td><code>${escapeHtml(k.keyPrefix || "—")}…</code></td>
        <td>${escapeHtml(k.scope || "—")}${k.isPlaygroundKey ? " · playground" : ""}${k.isPublicFacing ? " · public" : ""}</td>
        <td>${formatDate(k.createdAt)}</td>
        <td>${k.lastUsed ? formatDate(k.lastUsed) : "Never"}</td>
        <td>${k.isActive
          ? `<span class="status-badge success">Active</span>`
          : `<span class="status-badge error">Revoked</span>`}</td>
        <td>
          ${k.isActive
            ? `<button class="link-btn" data-action="revoke-key" data-uid="${escapeHtml(uid)}" data-key-id="${escapeHtml(k.id)}" data-key-name="${escapeHtml(k.name || k.keyPrefix || "this key")}">Revoke</button>`
            : `<span style="color:var(--text-muted);font-size:0.8125rem;">${k.revokeReason === "admin_force_logout" ? "Force-logout" : k.revokeReason === "admin_single_key_revoke" ? "Admin-revoked" : "Revoked"}</span>`}
        </td>
      </tr>
    `).join("");

    wrap.innerHTML = `
      <table class="studio-table">
        <thead><tr><th>Name</th><th>Prefix</th><th>Scope</th><th>Created</th><th>Last used</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    wrap.querySelectorAll('[data-action="revoke-key"]').forEach((btn) => {
      btn.addEventListener("click", () => openRevokeKeyModal(btn.dataset.uid, btn.dataset.keyId, btn.dataset.keyName));
    });
  } catch (e) {
    wrap.innerHTML = `<div class="error-state">Couldn't load API keys: ${escapeHtml(e.message)}</div>`;
  }
}

function openRevokeKeyModal(uid, keyId, keyName) {
  modalTitle.textContent = "Revoke key";
  modalBody.innerHTML = `<div>This revokes "${escapeHtml(keyName)}" only. Any other active keys for this user keep working — use Force logout instead if you need to kill every session.</div>`;
  modalConfirm.textContent = "Revoke key";
  modalConfirm.classList.add("btn-danger");
  modalConfirm.classList.remove("btn-primary");
  modalOverlay.classList.add("visible");

  modalConfirm.onclick = async () => {
    modalConfirm.disabled = true;
    modalConfirm.textContent = "Revoking…";
    try {
      await adminApi.revokeKey(uid, keyId);
      closeModal();
      showToast(`Revoked "${keyName}".`, "success");
      loadUserKeys(uid);
      // Active-key count on the stat card above is now stale by one —
      // patch it in place rather than rebuilding the whole detail view
      // (which would reset the visible tab back to Profile).
      document.querySelectorAll("#view-user-detail .stat-card").forEach((card) => {
        if (card.querySelector(".stat-label")?.textContent === "Active API keys") {
          const valEl = card.querySelector(".stat-value");
          const current = parseInt(valEl.textContent, 10);
          if (!isNaN(current) && current > 0) {
            const suffix = valEl.querySelector("span");
            valEl.innerHTML = `${current - 1} `;
            if (suffix) valEl.appendChild(suffix);
          }
        }
      });
    } catch (e) {
      showToast(`Couldn't revoke key: ${e.message}`, "error");
    } finally {
      modalConfirm.disabled = false;
      modalConfirm.textContent = "Revoke key";
    }
  };
}

// ── Global Request Logs ──────────────────────────────────────
async function loadLogs({ reset = false } = {}) {
  const el = document.getElementById("view-logs");

  if (reset) {
    currentLogsCursor = null;
    el.innerHTML = `
      <div class="main-header">
        <div class="main-title">Request logs</div>
        <div class="main-sub">Every API call across all users, newest first.</div>
      </div>
      <div class="filter-bar">
        <input class="studio-input" id="logs-filter-user" placeholder="Filter by user ID" />
        <input class="studio-input" id="logs-filter-agent" placeholder="Filter by agent" />
        <input class="studio-input" id="logs-filter-model" placeholder="Filter by model" />
        <select class="studio-select" id="logs-filter-status">
          <option value="">Any status</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
        </select>
        <button class="btn btn-primary btn-sm" id="logs-filter-apply">Apply</button>
        <button class="btn btn-ghost btn-sm" id="logs-filter-clear">Clear</button>
      </div>
      <div id="logs-table-wrap">${skelTable(8, 8)}</div>
      <div class="load-more-wrap" id="logs-load-more-wrap"></div>
    `;

    document.getElementById("logs-filter-apply").addEventListener("click", () => loadLogs({ reset: true }));
    document.getElementById("logs-filter-clear").addEventListener("click", () => {
      document.getElementById("logs-filter-user").value = "";
      document.getElementById("logs-filter-agent").value = "";
      document.getElementById("logs-filter-model").value = "";
      document.getElementById("logs-filter-status").value = "";
      loadLogs({ reset: true });
    });
  }

  const wrap = document.getElementById("logs-table-wrap");
  const loadMoreWrap = document.getElementById("logs-load-more-wrap");

  const userId = document.getElementById("logs-filter-user")?.value.trim();
  const agent = document.getElementById("logs-filter-agent")?.value.trim();
  const model = document.getElementById("logs-filter-model")?.value.trim();
  const status = document.getElementById("logs-filter-status")?.value.trim();

  try {
    const params = { limit: 25 };
    if (userId) params.userId = userId;
    if (agent) params.agent = agent;
    if (model) params.model = model;
    if (status) params.status = status;
    if (currentLogsCursor) params.cursor = currentLogsCursor;

    const data = await adminApi.logs(params);

    if (!data.logs.length && reset) {
      wrap.innerHTML = `<div class="empty-state">No request logs match these filters.</div>`;
      loadMoreWrap.innerHTML = "";
      return;
    }

    const rows = data.logs.map((l) => `
      <tr>
        <td>${formatDate(l.timestamp)}</td>
        <td class="clickable" data-uid="${escapeHtml(l.userId || "")}" style="font-family:var(--font-mono);font-size:0.75rem;">${escapeHtml(shorten(l.userId))}</td>
        <td>${escapeHtml(l.agent)}</td>
        <td>${escapeHtml(l.model)}</td>
        <td>${escapeHtml(l.provider)}</td>
        <td>${l.status === "success" ? `<span class="status-badge success">success</span>` : `<span class="status-badge error">${escapeHtml(l.errorCode || "error")}</span>`}</td>
        <td>${formatNumber(l.tokens?.total)}</td>
        <td>${formatNumber(l.latencyMs)}ms</td>
      </tr>
    `).join("");

    const tableHtml = `
      <table class="studio-table">
        <thead><tr><th>Time</th><th>User</th><th>Agent</th><th>Model</th><th>Provider</th><th>Status</th><th>Tokens</th><th>Latency</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    if (reset) wrap.innerHTML = tableHtml;
    else wrap.querySelector("tbody").insertAdjacentHTML("beforeend", rows);

    wrap.querySelectorAll("td.clickable[data-uid]").forEach((td) => {
      if (td.dataset.uid) td.addEventListener("click", () => showView("user-detail", { uid: td.dataset.uid }));
    });

    currentLogsCursor = data.nextCursor;
    loadMoreWrap.innerHTML = data.nextCursor ? `<button class="btn btn-outline" id="logs-load-more">Load more</button>` : "";
    if (data.nextCursor) {
      document.getElementById("logs-load-more").addEventListener("click", (e) => {
        e.target.textContent = "Loading…";
        e.target.disabled = true;
        loadLogs({ reset: false });
      });
    }
  } catch (e) {
    if (reset) wrap.innerHTML = `<div class="error-state">Couldn't load logs: ${escapeHtml(e.message)}</div>`;
    else showToast(`Couldn't load more logs: ${e.message}`, "error");
  }
}

// ── Access Log ───────────────────────────────────────────────
async function loadAccessLog() {
  const el = document.getElementById("view-access-log");
  el.innerHTML = `<div class="main-header"><div class="main-title">Access log</div><div class="main-sub">Unauthorized attempts to reach the admin API.</div></div>${skelTable(5, 4)}`;
  try {
    const data = await adminApi.accessLog({ limit: 50 });
    if (!data.attempts.length) {
      el.innerHTML = `<div class="main-header"><div class="main-title">Access log</div></div><div class="empty-state">No unauthorized access attempts logged.</div>`;
      return;
    }
    const rows = data.attempts.map((a) => `
      <tr>
        <td>${formatDate(a.timestamp)}</td>
        <td>${escapeHtml(a.email || "unknown")}</td>
        <td>${escapeHtml(a.ip || "—")}</td>
        <td>${escapeHtml(a.path || "—")}</td>
        <td>${escapeHtml(a.reason || "—")}</td>
      </tr>
    `).join("");

    el.innerHTML = `
      <div class="main-header">
        <div class="main-title">Access log</div>
        <div class="main-sub">Unauthorized attempts to reach the admin API.</div>
      </div>
      <table class="studio-table">
        <thead>
          <tr><th>Time</th><th>Email</th><th>IP</th><th>Path</th><th>Reason</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch (e) {
    el.innerHTML = `<div class="error-state">Couldn't load access log: ${escapeHtml(e.message)}</div>`;
  }
}

// ── Action Modals ────────────────────────────────────────────
const modalOverlay = document.getElementById("modal-overlay");
const modalTitle   = document.getElementById("modal-title");
const modalBody    = document.getElementById("modal-body");
const modalCancel  = document.getElementById("modal-cancel");
const modalConfirm = document.getElementById("modal-confirm");

function closeModal() {
  modalOverlay.classList.remove("visible");
  modalConfirm.onclick = null;
}

modalCancel.addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});

function openTierModal(uid, email, currentTier) {
  modalTitle.textContent = "Change tier";
  modalBody.innerHTML = `
    <div>${escapeHtml(email || uid)}</div>
    <select class="studio-select" id="modal-tier-select">
      ${ASSIGNABLE_TIERS.map((t) => `<option value="${t.id}" ${t.id === currentTier ? "selected" : ""}>${t.name}</option>`).join("")}
    </select>
  `;
  modalConfirm.textContent = "Change tier";
  modalConfirm.classList.remove("btn-danger");
  modalConfirm.classList.add("btn-primary");
  modalOverlay.classList.add("visible");

  modalConfirm.onclick = async () => {
    const tier = document.getElementById("modal-tier-select").value;
    modalConfirm.disabled = true;
    modalConfirm.textContent = "Changing…";
    try {
      await adminApi.setTier(uid, tier);
      closeModal();
      modalConfirm.classList.remove("btn-primary");
      modalConfirm.classList.add("btn-danger");
      showToast(`Tier changed to ${tier}.`, "success");
      refreshCurrentView(uid);
    } catch (e) {
      showToast(`Couldn't change tier: ${e.message}`, "error");
    } finally {
      modalConfirm.disabled = false;
      modalConfirm.textContent = "Change tier";
    }
  };
}

function openSuspendModal(uid, email, isSuspended) {
  const willSuspend = !isSuspended;
  modalTitle.textContent = willSuspend ? "Suspend user" : "Unsuspend user";
  modalBody.innerHTML = willSuspend
    ? `
      <div>${escapeHtml(email || uid)} will lose access on every request path (dashboard, API keys, MCP) immediately.</div>
      <input class="studio-input" id="modal-suspend-reason" placeholder="Reason (optional)" />
    `
    : `<div>${escapeHtml(email || uid)} will regain access immediately.</div>`;
  modalConfirm.textContent = willSuspend ? "Suspend" : "Unsuspend";
  modalConfirm.classList.add("btn-danger");
  modalConfirm.classList.remove("btn-primary");
  modalOverlay.classList.add("visible");

  modalConfirm.onclick = async () => {
    const reason = willSuspend ? document.getElementById("modal-suspend-reason").value.trim() : undefined;
    modalConfirm.disabled = true;
    modalConfirm.textContent = "Working…";
    try {
      await adminApi.setSuspended(uid, willSuspend, reason);
      closeModal();
      showToast(willSuspend ? "User suspended." : "User unsuspended.", "success");
      refreshCurrentView(uid);
    } catch (e) {
      showToast(`Couldn't update suspension: ${e.message}`, "error");
    } finally {
      modalConfirm.disabled = false;
      modalConfirm.textContent = willSuspend ? "Suspend" : "Unsuspend";
    }
  };
}

function openForceLogoutModal(uid, email) {
  modalTitle.textContent = "Force logout";
  modalBody.innerHTML = `<div>This revokes every active API key for ${escapeHtml(email || uid)}. Any connected client (dashboard, MCP, integrations) will need to generate a new key to continue.</div>`;
  modalConfirm.textContent = "Force logout";
  modalConfirm.classList.add("btn-danger");
  modalConfirm.classList.remove("btn-primary");
  modalOverlay.classList.add("visible");

  modalConfirm.onclick = async () => {
    modalConfirm.disabled = true;
    modalConfirm.textContent = "Revoking…";
    try {
      const result = await adminApi.forceLogout(uid);
      closeModal();
      showToast(`Revoked ${result.revoked} key${result.revoked === 1 ? "" : "s"}.`, "success");
      refreshCurrentView(uid);
    } catch (e) {
      showToast(`Couldn't force logout: ${e.message}`, "error");
    } finally {
      modalConfirm.disabled = false;
      modalConfirm.textContent = "Force logout";
    }
  };
}

function refreshCurrentView(uid) {
  const activeView = document.querySelector(".view.active")?.id?.replace("view-", "");
  if (activeView === "user-detail" && currentUserDetailUid === uid) {
    loadUserDetail(uid);
  } else if (activeView === "users") {
    loadUsers({ reset: true });
  }
}

// ── Toast ────────────────────────────────────────────────────
let toastTimer = null;
function showToast(message, kind = "") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = `toast visible ${kind ? `toast-${kind}` : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3500);
}

// ── Helpers ──────────────────────────────────────────────────
function renderTierBadge(tier, staleDeveloperTag) {
  if (staleDeveloperTag) {
    return `<span class="status-badge warning" title="tier:developer in DB but email doesn't match the admin account — server force-downgrades this to free on their next request">${escapeHtml(tier)} ⚠</span>`;
  }
  return `<span class="status-badge ${tier === "developer" ? "success" : ""}">${escapeHtml(tier)}</span>`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}

function shorten(str) {
  if (!str) return "—";
  return str.length > 12 ? `${str.slice(0, 12)}…` : str;
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatNumber(n) {
  return new Intl.NumberFormat().format(n || 0);
}

// ── Skeleton loaders ─────────────────────────────────────────
// Content-shaped placeholders, swapped in for the plain spinner
// on every page's initial load so the layout doesn't pop from
// empty to full once data arrives.
function skelStatGrid(count = 4) {
  const cards = Array.from({ length: count }, () => `
    <div class="skel-stat-card">
      <div class="skel skel-label"></div>
      <div class="skel skel-value"></div>
    </div>
  `).join("");
  return `<div class="skel-stat-grid">${cards}</div>`;
}

function skelTable(rows = 6, cols = 5) {
  const row = `<div class="skel-row">${Array.from({ length: cols }, () => `<div class="skel"></div>`).join("")}</div>`;
  return `<div class="skel-table">${row.repeat(rows)}</div>`;
}

function skelBlock({ rows = 3 } = {}) {
  const line = (w) => `<div class="skel skel-block" style="width:${w}"></div>`;
  return `<div style="display:flex;flex-direction:column;gap:var(--space-3);">
    ${Array.from({ length: rows }, (_, i) => line(i === rows - 1 ? "40%" : "100%")).join("")}
  </div>`;
}

// ── Boot ─────────────────────────────────────────────────────
async function boot() {
  const isAdmin = await verifyAdminAccess();
  if (!isAdmin) return; // verifyAdminAccess already redirects on failure

  const user = getUser();
  identityEl.textContent = user?.email || "";

  loginScreen.style.display = "none";
  adminShell.classList.add("visible");
  showView("overview");
}

(async function main() {
  const user = await initAuth();
  if (user) {
    await boot();
  } else {
    loginScreen.style.display = "flex";
  }
})();

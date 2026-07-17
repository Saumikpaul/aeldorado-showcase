// js/ui.js — UI Helpers (Toasts, Modals, etc.)
// Aeldorado by Solanacy Technologies

/**
 * Show a toast notification.
 * @param {string} message
 * @param {"success"|"error"|"info"} type
 * @param {number} duration - ms
 */
export function toast(message, type = "info", duration = 3500) {
  const container = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  }, duration);
}

/**
 * Show modal with content.
 */
export function showModal(html) {
  const overlay = document.getElementById("modal-overlay");
  const content = document.getElementById("modal-content");
  content.innerHTML = html;
  overlay.style.display = "flex";
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
}

export function closeModal() {
  document.getElementById("modal-overlay").style.display = "none";
}

/**
 * Copy text to clipboard.
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard!", "success");
  } catch {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select(); document.execCommand("copy");
    document.body.removeChild(ta);
    toast("Copied!", "success");
  }
}

/**
 * Hide loader screen.
 */
export function hideLoader() {
  const loader = document.getElementById("loader");
  if (loader) loader.remove();
}
window.hideLoader = hideLoader;

/**
 * Animate a usage ring.
 */
export function animateRing(fillId, current, max) {
  const fill = document.getElementById(fillId);
  if (!fill) return;
  const circumference = 2 * Math.PI * 52; // r=52
  const pct = max === "unlimited" || max === Infinity ? 0 : Math.min(current / max, 1);
  const offset = circumference * (1 - pct);
  fill.style.strokeDasharray = circumference;
  fill.style.strokeDashoffset = offset;

  // Color coding
  if (pct > 0.9) fill.style.stroke = "var(--danger)";
  else if (pct > 0.7) fill.style.stroke = "var(--warning)";
  else fill.style.stroke = "var(--accent)";
}

/**
 * Animate a counter from 0 to target.
 */
export function animateCounter(elementId, target, duration = 800) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const start = parseInt(el.textContent) || 0;
  const range = target - start;
  const startTime = performance.now();

  function tick(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    el.textContent = Math.round(start + range * eased).toLocaleString();
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/**
 * Format date for display.
 */
export function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

// js/config.js — Firebase & API Configuration
// Aeldorado by Solanacy Technologies

export const FIREBASE_CONFIG = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "1:YOUR_SENDER_ID:web:5b05e9d5fa382ccd528e22",
  measurementId: "G-YOUR_MEASUREMENT_ID",
};

export const API_BASE = window.location.hostname === "localhost"
  ? "http://localhost:3000"
  : "https://api.aeldorado.solanacy.in";

// ═══════════════════════════════════════════════════════════
//  SVG ICONS — replace all emojis with inline SVGs
// ═══════════════════════════════════════════════════════════
export const ICONS = {
  // Provider icons
  gemini: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/><path d="M12 2v20M2 12h20M5.64 5.64l12.72 12.72M18.36 5.64L5.64 18.36" opacity=".4"/></svg>`,
  openai: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.74 7.86a4.49 4.49 0 00-.39-4.37A4.56 4.56 0 0015.48 1a4.49 4.49 0 00-4.29 3.07A4.49 4.49 0 007.32 5.5a4.56 4.56 0 00-2.61 5.14 4.49 4.49 0 00-.67 5.06 4.56 4.56 0 004.87 2.49 4.49 4.49 0 004.29 3.07 4.56 4.56 0 004.87-2.49 4.49 4.49 0 003.86-1.43 4.56 4.56 0 00-1.19-6.48z"/><path d="M12 8v8M8 12h8" opacity=".4"/></svg>`,
  anthropic: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2L2 19h20L12 2z"/><path d="M12 8v5M12 16v.01" opacity=".4"/></svg>`,

  // Navigation
  dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
  keys: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.78 7.78 5.5 5.5 0 017.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
  vault: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/><circle cx="12" cy="16" r="1"/></svg>`,
  playground: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><line x1="14" y1="4" x2="10" y2="20"/></svg>`,
  docs: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
  logs: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`,
  signout: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,

  // Status & UI
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`,
  unlock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 019.9-1"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="20 6 9 17 4 12"/></svg>`,
  x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
  chart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>`,
  zap: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  menu: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`,

  // Agents
  ceo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/><path d="M12 3l1.5 2L12 7l-1.5-2L12 3z" opacity=".4"/></svg>`,
  cfo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>`,
  sales: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`,
  support: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>`,
  research: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  marketing: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  legal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>`,
};

/**
 * Get SVG icon by name, with optional size class.
 */
export function icon(name, className = "icon") {
  return `<span class="${className}">${ICONS[name] || ""}</span>`;
}

// ═══════════════════════════════════════════════════════════
//  PROVIDER DETECTION (client-side mirror of backend)
// ═══════════════════════════════════════════════════════════
export const PROVIDERS = {
  gemini: {
    name: "Google Gemini",
    icon: "gemini",
    detect: (key) => key.startsWith("AIza"),
    models: [
      { id: "gemini-3.5-flash",      name: "Gemini 3.5 Flash",       tier: "flagship", context: "1M" },
      { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite",  tier: "fast",     context: "1M" },
      { id: "gemini-2.5-pro",        name: "Gemini 2.5 Pro",         tier: "pro",      context: "1M" },
      { id: "gemini-2.5-flash",      name: "Gemini 2.5 Flash",       tier: "fast",     context: "1M" },
      { id: "gemma-4-31b-it",        name: "Gemma 4 31B",            tier: "open",     context: "128K" },
      { id: "gemma-4-26b-a4b-it",    name: "Gemma 4 26B A4B",        tier: "open",     context: "128K" },
      { id: "gemma-4-12b-it",        name: "Gemma 4 12B",            tier: "open",     context: "128K" },
    ],
    defaultModel: "gemini-3.5-flash",
  },
  openai: {
    name: "OpenAI",
    icon: "openai",
    detect: (key) => key.startsWith("sk-") && !key.startsWith("sk-ant-"),
    models: [
      { id: "gpt-5.5",       name: "GPT-5.5",        tier: "flagship", context: "1M" },
      { id: "gpt-5.4",       name: "GPT-5.4",        tier: "pro",      context: "1M" },
      { id: "gpt-5.4-pro",   name: "GPT-5.4 Pro",    tier: "pro",      context: "1M" },
      { id: "gpt-5.4-mini",  name: "GPT-5.4 Mini",   tier: "fast",     context: "512K" },
      { id: "gpt-5.4-nano",  name: "GPT-5.4 Nano",   tier: "fast",     context: "128K" },
    ],
    defaultModel: "gpt-5.4-mini",
  },
  anthropic: {
    name: "Anthropic Claude",
    icon: "anthropic",
    detect: (key) => key.startsWith("sk-ant-"),
    models: [
      { id: "claude-opus-4-8",   name: "Claude Opus 4.8",   tier: "flagship", context: "200K" },
      { id: "claude-opus-4-7",   name: "Claude Opus 4.7",   tier: "pro",      context: "200K" },
      { id: "claude-opus-4-6",   name: "Claude Opus 4.6",   tier: "pro",      context: "200K" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", tier: "balanced", context: "200K" },
      { id: "claude-haiku-4-5",  name: "Claude Haiku 4.5",  tier: "fast",     context: "200K" },
    ],
    defaultModel: "claude-sonnet-4-6",
  },
};

export function detectProvider(key) {
  if (!key || key.length < 10) return null;
  for (const [id, p] of Object.entries(PROVIDERS)) {
    if (p.detect(key)) return { id, ...p };
  }
  return null;
}

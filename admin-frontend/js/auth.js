// js/auth.js — Admin Portal Authentication
// Aeldorado by Solanacy Technologies
//
// IMPORTANT: This module only handles Google sign-in and token storage.
// It does NOT and must NOT decide who is an admin. That decision happens
// exclusively on the backend (core/admin-auth.js requireSuperAdmin), which
// checks the server-verified Firebase token against a hardcoded email.
//
// Every page load calls verifyAdminAccess(), which hits GET /v1/admin/whoami.
// If the backend says no (403), we sign the user out and redirect to the
// public app — never render any admin UI on an unconfirmed session.

import { FIREBASE_CONFIG, API_BASE, PUBLIC_APP_URL } from "./config.js";

let app, auth, provider;
let currentUser = null;
let idToken = null;

export async function initAuth() {
  const { initializeApp } = await import("https://www.gstatic.com/firebasejs/11.8.1/firebase-app.js");
  const { getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut } =
    await import("https://www.gstatic.com/firebasejs/11.8.1/firebase-auth.js");

  app = initializeApp(FIREBASE_CONFIG);
  auth = getAuth(app);
  provider = new GoogleAuthProvider();

  window._adminFirebase = { signInWithPopup, signOut, GoogleAuthProvider };

  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      currentUser = user;
      if (user) {
        idToken = await user.getIdToken(true);
      } else {
        idToken = null;
      }
      resolve(user);
    });
  });
}

export async function signInWithGoogle() {
  const { signInWithPopup } = window._adminFirebase;
  const cred = await signInWithPopup(auth, provider);
  idToken = await cred.user.getIdToken(true);
  return cred.user;
}

export async function signOutAndRedirect(redirectUrl) {
  const { signOut } = window._adminFirebase;
  try { await signOut(auth); } catch {}
  idToken = null;
  currentUser = null;
  window.location.href = redirectUrl || PUBLIC_APP_URL;
}

export function getToken() {
  return idToken;
}

export function getUser() {
  return currentUser;
}

/**
 * Hard server-side check. Call this before rendering ANY admin content.
 * Returns true only if the backend's requireSuperAdmin gate accepted the
 * current token. On any failure, signs out and redirects immediately.
 */
export async function verifyAdminAccess() {
  if (!idToken) {
    window.location.href = PUBLIC_APP_URL;
    return false;
  }

  try {
    const res = await fetch(`${API_BASE}/v1/admin/whoami`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });

    if (res.status === 403 || res.status === 401) {
      const body = await res.json().catch(() => ({}));
      await signOutAndRedirect(body.redirect || undefined);
      return false;
    }

    if (!res.ok) return false;

    const data = await res.json();
    return data.admin === true;
  } catch (e) {
    console.error("Admin verification failed:", e);
    return false;
  }
}

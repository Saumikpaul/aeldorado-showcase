// js/auth.js — Firebase Authentication
// Aeldorado by Solanacy Technologies

import { FIREBASE_CONFIG } from "./config.js";
import { setAuthToken } from "./api.js";

// Firebase SDK (CDN modules)
let app, auth, provider;
let currentUser = null;
let onAuthChange = null;

/**
 * Initialize Firebase Auth.
 */
export async function initAuth(callback) {
  onAuthChange = callback;

  const { initializeApp } = await import("https://www.gstatic.com/firebasejs/11.8.1/firebase-app.js");
  const { getAuth, onAuthStateChanged, onIdTokenChanged, signInWithPopup, GoogleAuthProvider,
          signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, updateProfile
        } = await import("https://www.gstatic.com/firebasejs/11.8.1/firebase-auth.js");

  app = initializeApp(FIREBASE_CONFIG);
  auth = getAuth(app);
  provider = new GoogleAuthProvider();

  // Store refs for later use
  window._firebaseAuth = {
    signInWithPopup, GoogleAuthProvider, provider,
    signInWithEmailAndPassword, createUserWithEmailAndPassword,
    signOut, updateProfile
  };

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
      // Token SET kore tarpor callback — race condition fix
      try {
        const token = await user.getIdToken(true);
        setAuthToken(token);
      } catch (error) {
        console.error("Failed to get ID token:", error);
        setAuthToken(null);
      }
    } else {
      setAuthToken(null);
    }
    if (onAuthChange) onAuthChange(user);
  });

  // Proactive refresh: Firebase ID tokens expire after 1hr.
  // Force-refresh every 50 min so an active session never goes stale.
  if (!window._pgTokenRefreshInterval) {
    window._pgTokenRefreshInterval = setInterval(async () => {
      if (currentUser) {
        try {
          const token = await currentUser.getIdToken(true);
          setAuthToken(token);
        } catch (error) {
          console.error("Failed to proactively refresh ID token:", error);
        }
      }
    }, 50 * 60 * 1000);
  }

  // Token refresh handler (expiry renewal er jonno)
  onIdTokenChanged(auth, async (user) => {
    if (user) {
      try {
        const token = await user.getIdToken();
        setAuthToken(token);
      } catch (error) {
        console.error("Failed to refresh ID token:", error);
      }
    } else {
      setAuthToken(null);
    }
  });
}

/**
 * Force-refresh the current user's ID token. Used by api.js to
 * transparently retry a request after a stale-token 401.
 * @returns {Promise<boolean>} true if refreshed successfully
 */
export async function refreshAuthToken() {
  if (!currentUser) return false;
  try {
    const token = await currentUser.getIdToken(true);
    setAuthToken(token);
    return true;
  } catch (error) {
    console.error("Failed to refresh ID token on demand:", error);
    return false;
  }
}

/**
 * Sign in with Google popup.
 */
export async function signInWithGoogle() {
  const { signInWithPopup, provider } = window._firebaseAuth;
  return signInWithPopup(auth, provider);
}

/**
 * Sign in with email/password.
 */
export async function signInWithEmail(email, password) {
  const { signInWithEmailAndPassword } = window._firebaseAuth;
  return signInWithEmailAndPassword(auth, email, password);
}

/**
 * Sign up with email/password.
 */
export async function signUpWithEmail(email, password, displayName) {
  const { createUserWithEmailAndPassword, updateProfile } = window._firebaseAuth;
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  if (displayName) {
    await updateProfile(cred.user, { displayName });
  }
  return cred;
}

/**
 * Sign out.
 */
export async function signOutUser() {
  const { signOut } = window._firebaseAuth;
  return signOut(auth);
}

/**
 * Get current user.
 */
export function getCurrentUser() {
  return currentUser;
}

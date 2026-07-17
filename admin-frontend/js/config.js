// js/config.js — Admin Portal Configuration
// Aeldorado by Solanacy Technologies
//
// Same Firebase project as the public app (aeldorado-agentic-era) — the
// backend already trusts tokens from this project via adminAuth.verifyIdToken.
// Access control is NOT done here on the client; it's enforced server-side
// by requireSuperAdmin on every /v1/admin/* route. This config only wires up
// login — the client-side email check below is a UX convenience so a
// non-admin sees an immediate message instead of a blank/broken dashboard.

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyB5WaNqeQeoMbCMjy1zboBQyN_oqAx40Mk",
  authDomain: "aeldorado-agentic-era.firebaseapp.com",
  projectId: "aeldorado-agentic-era",
  storageBucket: "aeldorado-agentic-era.firebasestorage.app",
  messagingSenderId: "171722973831",
  appId: "1:171722973831:web:5b05e9d5fa382ccd528e22",
  measurementId: "G-KL2LQWJXDC",
};

export const API_BASE = window.location.hostname === "localhost"
  ? "http://localhost:3000"
  : "https://api.aeldorado.solanacy.in";

export const PUBLIC_APP_URL = "https://aeldorado.solanacy.in";

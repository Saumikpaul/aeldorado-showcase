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

export const PUBLIC_APP_URL = "https://aeldorado.solanacy.in";

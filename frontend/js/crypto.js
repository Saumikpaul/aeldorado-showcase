// js/crypto.js — Client-side AES-256-GCM Encryption
// Aeldorado by Solanacy Technologies
//
// Uses Web Crypto API for browser-side encryption.
// Must produce output compatible with the server-side Node.js crypto module.

const ITERATIONS  = 100000;
const KEY_LENGTH  = 256;     // bits
const IV_LENGTH   = 16;      // bytes
const SALT_LENGTH = 32;      // bytes

/**
 * Derive an AES-256 key from a password and salt using PBKDF2.
 * Must match the server-side derivation exactly.
 */
async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-512" },
    keyMaterial,
    { name: "AES-GCM", length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Convert ArrayBuffer to hex string.
 */
function bufToHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Convert hex string to Uint8Array.
 */
function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Encrypt plaintext with a password using AES-256-GCM.
 * Returns hex-encoded components compatible with server-side decryption.
 *
 * @param {string} plaintext
 * @param {string} password
 * @returns {Promise<{ ciphertext: string, iv: string, salt: string, tag: string }>}
 */
export async function encrypt(plaintext, password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv   = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key  = await deriveKey(password, salt);

  const enc = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    enc.encode(plaintext)
  );

  // Web Crypto API appends the auth tag to the ciphertext
  const encBytes = new Uint8Array(encrypted);
  const ciphertextBytes = encBytes.slice(0, encBytes.length - 16);
  const tagBytes = encBytes.slice(encBytes.length - 16);

  return {
    ciphertext: bufToHex(ciphertextBytes),
    iv:         bufToHex(iv),
    salt:       bufToHex(salt),
    tag:        bufToHex(tagBytes),
  };
}

/**
 * Decrypt ciphertext with a password using AES-256-GCM.
 *
 * @param {{ ciphertext: string, iv: string, salt: string, tag: string }} encrypted
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function decrypt(encrypted, password) {
  const salt = hexToBuf(encrypted.salt);
  const iv   = hexToBuf(encrypted.iv);
  const ct   = hexToBuf(encrypted.ciphertext);
  const tag  = hexToBuf(encrypted.tag);
  const key  = await deriveKey(password, salt);

  // Reassemble: ciphertext + tag (Web Crypto API expects them concatenated)
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct, 0);
  combined.set(tag, ct.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    combined
  );

  return new TextDecoder().decode(decrypted);
}

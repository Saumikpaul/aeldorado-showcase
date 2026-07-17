// core/encryption.js — AES-256-GCM E2E Key Vault Encryption
// Aeldorado by Solanacy Technologies
//
// This module handles server-side decryption of user API keys.
// Keys are encrypted CLIENT-SIDE in the browser using Web Crypto API,
// stored as ciphertext, and only decrypted here in-memory during API calls.
// The plaintext is NEVER persisted.

import crypto from "crypto";

const ALGORITHM   = "aes-256-gcm";
const KEY_LENGTH  = 32;           // 256 bits
const IV_LENGTH   = 16;           // 128 bits
const SALT_LENGTH = 32;           // 256 bits
const TAG_LENGTH  = 16;           // 128 bits
const ITERATIONS  = 100_000;      // PBKDF2 iterations
const DIGEST      = "sha512";

/**
 * Derive a 256-bit AES key from a password and salt using PBKDF2.
 * Must match the client-side Web Crypto API derivation exactly.
 */
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
}

/**
 * Encrypt plaintext with a password using AES-256-GCM.
 * Used server-side as a fallback / migration path.
 * Primary encryption should happen client-side.
 *
 * @param {string} plaintext - The data to encrypt
 * @param {string} password  - User's encryption password
 * @returns {{ ciphertext: string, iv: string, salt: string, tag: string }}
 *          All values are hex-encoded strings.
 */
export function encrypt(plaintext, password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv   = crypto.randomBytes(IV_LENGTH);
  const key  = deriveKey(password, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted,
    iv:         iv.toString("hex"),
    salt:       salt.toString("hex"),
    tag:        tag.toString("hex"),
  };
}

/**
 * Decrypt ciphertext with a password using AES-256-GCM.
 * Used to recover the user's API key in-memory during an API call.
 * The result is used immediately and then discarded — never persisted.
 *
 * @param {{ ciphertext: string, iv: string, salt: string, tag: string }} encrypted
 *        All values are hex-encoded strings.
 * @param {string} password - User's encryption password
 * @returns {string} The decrypted plaintext
 * @throws {Error} If decryption fails (wrong password or tampered data)
 */
export function decrypt(encrypted, password) {
  const salt = Buffer.from(encrypted.salt, "hex");
  const iv   = Buffer.from(encrypted.iv, "hex");
  const tag  = Buffer.from(encrypted.tag, "hex");
  const key  = deriveKey(password, salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted.ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * Verify that a password can decrypt the given encrypted data.
 * Does not return the plaintext — only confirms success/failure.
 *
 * @param {{ ciphertext: string, iv: string, salt: string, tag: string }} encrypted
 * @param {string} password
 * @returns {boolean}
 */
export function verifyDecryption(encrypted, password) {
  try {
    decrypt(encrypted, password);
    return true;
  } catch {
    return false;
  }
}

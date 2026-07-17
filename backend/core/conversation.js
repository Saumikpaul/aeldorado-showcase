// core/conversation.js — Multi-turn Conversation History
// Aeldorado by Solanacy Technologies
//
// Stores conversation context in Firestore for multi-turn support.
// Each conversation has a TTL of 24 hours (auto-cleanup).

import crypto from "crypto";
import { logger } from "./logger.js";
import { FieldValue } from "firebase-admin/firestore";

const MAX_TURNS = 20;       // Max messages per conversation
const TTL_HOURS = 24;       // Conversation expiry

/**
 * Count active (non-expired) conversations for a user.
 * "Active" = createdAt within the last TTL_HOURS (24h) window.
 * Used to enforce the free-tier max-conversations limit.
 *
 * @param {object} db
 * @param {string} userId
 * @returns {Promise<number>}
 */
export async function countActiveConversations(db, userId) {
  try {
    const cutoffMs = Date.now() - TTL_HOURS * 60 * 60 * 1000;
    const snap = await db.collection("conversations")
      .where("userId", "==", userId)
      .get();
    let count = 0;
    snap.forEach(doc => {
      const createdAt = new Date(doc.data().createdAt).getTime();
      if (createdAt > cutoffMs) count++;
    });
    return count;
  } catch (e) {
    logger.error("countActiveConversations failed", { error: e.message, userId });
    // Fail open — don't block the user on a counting error
    return 0;
  }
}

/**
 * Check whether a user is allowed to start a brand-new conversation,
 * given their tier's maxConversations limit. Existing conversations
 * (conversationId passed in) are never blocked — only new ones.
 *
 * @param {object} db
 * @param {string} userId
 * @param {number} maxConversations - Infinity for unlimited
 * @returns {Promise<{ allowed: boolean, active: number }>}
 */
export async function canCreateConversation(db, userId, maxConversations) {
  if (maxConversations === Infinity || maxConversations == null) {
    return { allowed: true, active: 0 };
  }
  const active = await countActiveConversations(db, userId);
  return { allowed: active < maxConversations, active };
}

/**
 * Get or create a conversation.
 *
 * @param {object} db
 * @param {string} userId
 * @param {string} conversationId - Optional, creates new if not provided
 * @returns {Promise<{ conversationId: string, messages: Array }>}
 */
export async function getConversation(db, userId, conversationId) {
  if (!conversationId) {
    return {
      conversationId: `conv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      messages: [],
    };
  }

  try {
    const ref = db.collection("conversations").doc(conversationId);
    const snap = await ref.get();

    if (!snap.exists) {
      return { conversationId, messages: [] };
    }

    const data = snap.data();

    // Check ownership
    if (data.userId !== userId) {
      return { conversationId, messages: [] };
    }

    // Check TTL
    const createdAt = new Date(data.createdAt);
    if (Date.now() - createdAt.getTime() > TTL_HOURS * 60 * 60 * 1000) {
      await ref.delete().catch(() => {});
      return { conversationId, messages: [] };
    }

    return {
      conversationId,
      messages: data.messages || [],
    };
  } catch {
    return { conversationId, messages: [] };
  }
}

/**
 * Save a conversation turn (user message + assistant response).
 *
 * @param {object} db
 * @param {string} userId
 * @param {string} conversationId
 * @param {string} userMessage
 * @param {string} assistantResponse
 * @param {string} agent
 */
export async function saveConversationTurn(db, userId, conversationId, userMessage, assistantResponse, agent) {
  try {
    const ref = db.collection("conversations").doc(conversationId);
    const snap = await ref.get();
    const newMessages = [
      { role: "user",      content: userMessage,       timestamp: new Date().toISOString() },
      { role: "assistant", content: assistantResponse,  agent, timestamp: new Date().toISOString() }
    ];

    if (!snap.exists) {
      await ref.set({
        userId,
        conversationId,
        messages: newMessages,
        turns: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ttl: new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000),
      });
    } else {
      await ref.update({
        messages: FieldValue.arrayUnion(...newMessages),
        turns: FieldValue.increment(1),
        updatedAt: new Date().toISOString(),
        ttl: new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000),
      });
    }
  } catch (e) {
    logger.error("Conversation save failed", { error: e.message, conversationId });
  }
}

/**
 * Build conversation context string for the AI.
 */
export function buildContext(messages) {
  if (!messages || messages.length === 0) return "";

  return "\n\nPrevious conversation:\n" + messages.map(m =>
    `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`
  ).join("\n") + "\n\n";
}

/**
 * Delete a conversation.
 */
export async function deleteConversation(db, conversationId) {
  try {
    await db.collection("conversations").doc(conversationId).delete();
    return true;
  } catch {
    return false;
  }
}


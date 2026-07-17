// core/news-manager.js — Newsroom CMS
// Aeldorado by Solanacy Technologies
//
// Backs the public /news page (Anthropic-newsroom style) and the admin
// "Newsroom" CMS tab. Posts are authored as Markdown by the superadmin,
// stored in Firestore, and rendered client-side on the public site.
//
// Collection: news_posts
//   {
//     slug, title, excerpt, category, coverImage,
//     bodyMarkdown, status: "draft" | "published",
//     publishedAt, createdAt, updatedAt, authorEmail
//   }

import { logger } from "./logger.js";

const CATEGORIES = ["Product", "Announcements", "Policy", "Engineering"];

/**
 * Slugify a title into a URL-safe, unique-ish slug.
 * Collisions are resolved by the caller appending a short suffix.
 */
function slugify(title) {
  return String(title)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80)
    .replace(/^-+|-+$/g, "");
}

export function isValidCategory(category) {
  return CATEGORIES.includes(category);
}

export { CATEGORIES };

/**
 * Create a new post (starts as draft unless publishNow is true).
 */
export async function createPost(db, { title, excerpt, category, coverImage, bodyMarkdown, publishNow, authorEmail }) {
  const baseSlug = slugify(title);
  if (!baseSlug) {
    throw Object.assign(new Error("Title must contain at least one alphanumeric character."), { code: "INVALID_TITLE" });
  }

  // Ensure slug uniqueness — append a short counter if taken.
  let slug = baseSlug;
  let attempt = 1;
  while ((await db.collection("news_posts").doc(slug).get()).exists) {
    attempt += 1;
    slug = `${baseSlug}-${attempt}`;
    if (attempt > 50) {
      throw Object.assign(new Error("Could not generate a unique slug."), { code: "SLUG_EXHAUSTED" });
    }
  }

  const now = new Date().toISOString();
  const doc = {
    slug,
    title: String(title).trim(),
    excerpt: excerpt ? String(excerpt).trim().slice(0, 280) : "",
    category: isValidCategory(category) ? category : "Announcements",
    coverImage: coverImage || null,
    bodyMarkdown: bodyMarkdown || "",
    status: publishNow ? "published" : "draft",
    publishedAt: publishNow ? now : null,
    createdAt: now,
    updatedAt: now,
    authorEmail: authorEmail || null,
  };

  await db.collection("news_posts").doc(slug).set(doc);
  logger.info("News post created", { slug, status: doc.status });
  return doc;
}

/**
 * Update an existing post. Publishing for the first time stamps publishedAt.
 */
export async function updatePost(db, slug, updates) {
  const ref = db.collection("news_posts").doc(slug);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const existing = snap.data();
  const patch = { updatedAt: new Date().toISOString() };

  if (updates.title !== undefined) patch.title = String(updates.title).trim();
  if (updates.excerpt !== undefined) patch.excerpt = String(updates.excerpt).trim().slice(0, 280);
  if (updates.category !== undefined) patch.category = isValidCategory(updates.category) ? updates.category : existing.category;
  if (updates.coverImage !== undefined) patch.coverImage = updates.coverImage || null;
  if (updates.bodyMarkdown !== undefined) patch.bodyMarkdown = updates.bodyMarkdown;

  if (updates.status !== undefined && ["draft", "published"].includes(updates.status)) {
    patch.status = updates.status;
    if (updates.status === "published" && !existing.publishedAt) {
      patch.publishedAt = new Date().toISOString();
    }
    if (updates.status === "draft") {
      patch.publishedAt = null;
    }
  }

  await ref.update(patch);
  logger.info("News post updated", { slug, fields: Object.keys(patch) });
  return { ...existing, ...patch };
}

export async function deletePost(db, slug) {
  const ref = db.collection("news_posts").doc(slug);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.delete();
  logger.info("News post deleted", { slug });
  return true;
}

export async function getPostForAdmin(db, slug) {
  const snap = await db.collection("news_posts").doc(slug).get();
  return snap.exists ? snap.data() : null;
}

/**
 * List posts for the admin CMS — all statuses, newest first.
 */
export async function listPostsForAdmin(db, { limit = 50 } = {}) {
  const snap = await db.collection("news_posts")
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => d.data());
}

/**
 * Public: list published posts only, newest first.
 */
export async function listPublishedPosts(db, { limit = 20, category = null, cursor = null } = {}) {
  let q = db.collection("news_posts")
    .where("status", "==", "published")
    .orderBy("publishedAt", "desc");

  if (category && isValidCategory(category)) {
    q = db.collection("news_posts")
      .where("status", "==", "published")
      .where("category", "==", category)
      .orderBy("publishedAt", "desc");
  }

  if (cursor) {
    const cursorSnap = await db.collection("news_posts").doc(cursor).get();
    if (cursorSnap.exists) q = q.startAfter(cursorSnap);
  }

  const snap = await q.limit(limit).get();
  const posts = snap.docs.map((d) => d.data());
  const nextCursor = posts.length === limit ? posts[posts.length - 1].slug : null;

  return { posts, nextCursor };
}

/**
 * Public: get a single published post by slug.
 * Returns null for drafts too — public callers should never see unpublished content.
 */
export async function getPublishedPost(db, slug) {
  const snap = await db.collection("news_posts").doc(slug).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return data.status === "published" ? data : null;
}

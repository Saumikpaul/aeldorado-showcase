// routes/news.js — Public Newsroom API
// Aeldorado by Solanacy Technologies
//
// Mounted at /v1/news/* with publicCors, NO auth — this is the read-only
// feed that powers the public /news page. Only ever returns posts with
// status:"published"; drafts are invisible here regardless of how they're
// queried (see core/news-manager.js:listPublishedPosts/getPublishedPost).

import { Router } from "express";
import { sendError } from "../core/errors.js";
import { cached } from "../core/cache.js";
import { listPublishedPosts, getPublishedPost, CATEGORIES } from "../core/news-manager.js";

export const newsRouter = Router();

/**
 * GET /v1/news — List published posts, newest first.
 * Query: ?limit=20&category=Product&cursor=<slug>
 */
newsRouter.get("/news", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const category = req.query.category || null;
    const cursor = req.query.cursor || null;

    // Cursor-based pages aren't cached (each cursor is a distinct, less-hit
    // key); only the first page of each category is worth caching.
    const cacheKey = `news:list:${category || "all"}:${limit}`;
    const result = cursor
      ? await listPublishedPosts(req.db, { limit, category, cursor })
      : await cached(cacheKey, 30_000, () => listPublishedPosts(req.db, { limit, category }));

    res.json({
      posts: result.posts,
      nextCursor: result.nextCursor,
      categories: CATEGORIES,
      meta: { powered_by: "Aeldorado by Solanacy" },
    });
  } catch (e) {
    sendError(res, "INTERNAL_ERROR", e.message);
  }
});

/**
 * GET /v1/news/:slug — Fetch a single published post.
 */
newsRouter.get("/news/:slug", async (req, res) => {
  try {
    const cacheKey = `news:post:${req.params.slug}`;
    const post = await cached(cacheKey, 30_000, () => getPublishedPost(req.db, req.params.slug));
    if (!post) return sendError(res, "AGENT_NOT_FOUND", "Post not found.");
    res.json({ post, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch (e) {
    sendError(res, "INTERNAL_ERROR", e.message);
  }
});

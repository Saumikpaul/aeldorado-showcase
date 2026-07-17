import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { downgradeExpiredSubscriptions } from "../core/billing.js";

// Initialize Firebase Admin (Uses the exact same env variables as the main server)
let db;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
  db = getFirestore(undefined, process.env.FIRESTORE_DATABASE_ID || "your-project-id"); // [REDACTED — internal infra ID not included in public showcase]
  console.log("[OK] Firebase Admin initialized for Cron Job.");
} catch (e) {
  console.error("[FATAL] Firebase Admin init failed:", e.message);
  process.exit(1);
}

/**
 * Clean up the `ip_tracking` collection by removing user entries
 * that have not been seen in the last 7 days. If an IP document
 * has no users left, it deletes the entire document.
 */
async function runCleanup() {
  console.log("[CRON] Starting IP Tracking cleanup...");
  
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
  try {
    const ipRef = db.collection("ip_tracking");
    const snapshot = await ipRef.get();
    
    let totalScanned = 0;
    let totalUpdated = 0;
    let totalDeleted = 0;

    for (const doc of snapshot.docs) {
      totalScanned++;
      const data = doc.data();
      const users = data.users || {};
      
      let modified = false;
      
      // Iterate over each user under this IP
      for (const [userId, info] of Object.entries(users)) {
        const lastSeen = new Date(info.lastSeen);
        if (lastSeen < sevenDaysAgo) {
          delete users[userId];
          modified = true;
        }
      }
      
      // If we made changes
      if (modified) {
        if (Object.keys(users).length === 0) {
          // No users left on this IP, delete the document
          await doc.ref.delete();
          totalDeleted++;
        } else {
          // Update the document with remaining users
          await doc.ref.set({ users }, { merge: false });
          totalUpdated++;
        }
      }
    }
    
    console.log(`[CRON] Cleanup Complete.`);
    console.log(`[CRON] Scanned: ${totalScanned} IPs`);
    console.log(`[CRON] Updated: ${totalUpdated} IPs`);
    console.log(`[CRON] Deleted: ${totalDeleted} IPs`);
    
    // ── Subscription expiry cleanup ─────────────────────────────────────────
    console.log("[CRON] Checking expired subscriptions...");
    const downgraded = await downgradeExpiredSubscriptions(db);
    console.log(`[CRON] Downgraded ${downgraded} expired subscription(s) to free tier.`);

    process.exit(0);
  } catch (error) {
    console.error("[CRON] Failed to run cleanup:", error);
    process.exit(1);
  }
}

runCleanup();

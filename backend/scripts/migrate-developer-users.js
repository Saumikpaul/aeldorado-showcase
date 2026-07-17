// scripts/migrate-developer-users.js
// Aeldorado by Solanacy Technologies
//
// ONE-TIME MIGRATION: Moves all "developer" tier users (except the admin email)
// to "free" tier with freeActivated:false so they must complete the ₹1 activation.
//
// Usage:
//   node scripts/migrate-developer-users.js            — live run
//   node scripts/migrate-developer-users.js --dry-run  — preview only, no changes

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore }        from "firebase-admin/firestore";
import { DEVELOPER_PLAN_EMAIL, isAllowedDeveloperEmail } from "../core/billing.js";

// ── Init ──────────────────────────────────────────────────────────────────────
const IS_DRY_RUN = process.argv.includes("--dry-run");

let db;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
  db = getFirestore(undefined, process.env.FIRESTORE_DATABASE_ID || "your-project-id"); // [REDACTED — internal infra ID not included in public showcase]
} catch (e) {
  console.error("❌ Firebase init failed:", e.message);
  process.exit(1);
}

// ── Migration ─────────────────────────────────────────────────────────────────
async function migrate() {
  console.log("\n══════════════════════════════════════════════════════");
  console.log("  🏛  Aeldorado — Developer Plan Migration Script");
  console.log(`  Mode: ${IS_DRY_RUN ? "DRY RUN (no changes)" : "LIVE (writing to Firestore)"}`);
  console.log(`  Admin email (keeps developer plan): ${DEVELOPER_PLAN_EMAIL}`);
  console.log("══════════════════════════════════════════════════════\n");

  const snap = await db.collection("users")
    .where("tier", "==", "developer")
    .get();

  console.log(`Found ${snap.size} user(s) with tier:"developer"`);

  let kept    = 0;
  let migrated = 0;
  let errors  = 0;

  for (const doc of snap.docs) {
    const data  = doc.data();
    const email = data.email || "(no email)";
    const uid   = doc.id;

    if (isAllowedDeveloperEmail(email)) {
      console.log(`  ✅ KEEP    ${email} (${uid}) — admin, keeping developer plan`);
      kept++;
      continue;
    }

    console.log(`  🔄 MIGRATE ${email} (${uid}) → free (freeActivated: false)`);

    if (!IS_DRY_RUN) {
      try {
        await doc.ref.update({
          tier:            "free",
          freeActivated:   false,
          migratedAt:      new Date().toISOString(),
          migratedFrom:    "developer",
          migrationReason: "production_cleanup",
        });
        migrated++;
      } catch (e) {
        console.error(`    ❌ Failed to migrate ${uid}:`, e.message);
        errors++;
      }
    } else {
      migrated++;
    }
  }

  console.log("\n──────────────────────────────────────────────────────");
  console.log(`  Kept as developer: ${kept}`);
  console.log(`  Migrated to free:  ${migrated}${IS_DRY_RUN ? " (dry run — no actual changes)" : ""}`);
  console.log(`  Errors:            ${errors}`);
  console.log("──────────────────────────────────────────────────────\n");

  if (IS_DRY_RUN) {
    console.log("ℹ  This was a DRY RUN. Run without --dry-run to apply changes.\n");
  } else {
    console.log("✅ Migration complete!\n");
  }
}

migrate().catch(e => {
  console.error("Migration failed:", e);
  process.exit(1);
});

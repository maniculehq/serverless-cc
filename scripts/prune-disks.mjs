// prune-disks.mjs — reconciler backstop for per-user Archil disks.
//
//   bun run --env-file=.env scripts/prune-disks.mjs           # dry run (list orphans)
//   bun run --env-file=.env scripts/prune-disks.mjs --delete  # actually delete them
//
// The Better Auth user.delete hook (lib/auth.ts) deletes a user's disk when the
// account is removed THROUGH Better Auth, but a manual SQL row delete won't fire
// it. This script reconciles: it lists every live user, computes their expected
// cc-u-<hash> disk name (lib/user-disk.mjs#diskNameForUser), and deletes any
// cc-u-* disk with no matching live user.
import { Pool } from "pg";
import { diskNameForUser } from "../lib/user-disk.mjs";

const apply = process.argv.includes("--delete");

if (!process.env.ARCHIL_API_KEY) { console.error("prune: ARCHIL_API_KEY not set"); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error("prune: DATABASE_URL not set"); process.exit(1); }

// Same SSL handling as lib/auth.ts: strip libpq-only params and verify against
// Node's built-in CA store.
function pgPoolConfig(databaseUrl) {
  const url = new URL(databaseUrl);
  url.searchParams.delete("sslrootcert");
  url.searchParams.delete("sslmode");
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: true } };
}

const pool = new Pool(pgPoolConfig(process.env.DATABASE_URL));
let liveNames;
try {
  const { rows } = await pool.query('SELECT id FROM "user"');
  liveNames = new Set(rows.map((r) => diskNameForUser(r.id)));
  console.log(`[prune] ${rows.length} live user(s)`);
} finally {
  await pool.end();
}

const archil = await import("disk");
archil.configure({ apiKey: process.env.ARCHIL_API_KEY, region: process.env.ARCHIL_REGION });
const disks = await archil.listDisks();
const orphans = disks.filter((d) => (d.name || "").startsWith("cc-u-") && !liveNames.has(d.name));

console.log(`[prune] ${disks.length} disk(s) total, ${orphans.length} orphan cc-u-* disk(s)`);
for (const d of orphans) {
  if (apply) {
    try { await d.delete(); console.log(`  deleted ${d.name} (${d.id})`); }
    catch (e) { console.error(`  FAILED ${d.name} (${d.id}): ${e.message}`); }
  } else {
    console.log(`  would delete ${d.name} (${d.id})`);
  }
}
if (!apply && orphans.length) console.log("[prune] dry run — pass --delete to remove");

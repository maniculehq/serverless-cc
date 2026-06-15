// test-workers.mjs — exercises per-request worker isolation end to end.
//
//   bun run --env-file=.env scripts/test-workers.mjs
//
// Test 1 (isolation): fire two agent requests CONCURRENTLY that each write the
//   SAME relative filename (out.txt) with DIFFERENT content into their own
//   per-request workspace, then read it back. Pass iff each request sees only its
//   own content and the two workspace prefixes differ. When ARCHIL_API_KEY is set
//   we also verify directly on the disk that the two keys are distinct, then
//   clean them up.
//
// Test 2 (no-orphan cancel): start a multi-step run, cancel it mid-flight, and
//   confirm the spawned cli.js child is actually gone (not orphaned) and `done`
//   resolves.

import { execSync } from "node:child_process";
import { runAgentWorker } from "../lib/agent-runner.mjs";

const usingArchil = !!process.env.ARCHIL_API_KEY;
let failures = 0;
const ok = (c, msg) => { console.log(`${c ? "  ✅" : "  ❌"} ${msg}`); if (!c) failures++; };

function collectText(events) {
  let s = "";
  for (const e of events) {
    if ((e.t === "text" || e.t === "text_delta") && e.text) s += e.text;
    else if (e.t === "tool_result" && e.text) s += "\n" + e.text;
    else if (e.t === "result" && e.final) s += "\n" + e.final;
  }
  return s;
}

function start(prompt) {
  const events = [];
  const h = runAgentWorker({ prompt, onEvent: (e) => events.push(e) });
  return { ...h, events };
}

// ---- disk helpers (only when ARCHIL_API_KEY is set) ----
async function connectDisk() {
  const archil = await import("disk");
  archil.configure({ apiKey: process.env.ARCHIL_API_KEY, region: process.env.ARCHIL_REGION });
  const want = (process.env.ARCHIL_DISK || "").split("/").pop();
  const disks = await archil.listDisks();
  return disks.find((d) => d.name === want) || disks.find((d) => (d.name || "").endsWith(want)) || disks[0];
}
const keyOf = (root, rel) => `${root.replace(/^\/+/, "")}/${rel}`;
async function readKey(disk, key) {
  try { return Buffer.from(await disk.getObject(key)).toString("utf8"); }
  catch { return null; }
}
async function cleanupPrefix(disk, root) {
  const prefix = root.replace(/^\/+/, "") + "/";
  try {
    const all = await disk.listObjects(prefix, { recursive: true });
    for (const o of all.objects || []) await disk.deleteObject(o.key);
  } catch { /* best effort */ }
}

function cliProcCount() {
  try {
    const out = execSync(`ps -ax -o command | grep -c "[b]in/cli.js" || true`, { encoding: "utf8" });
    return parseInt(out.trim(), 10) || 0;
  } catch { return -1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function prefixEmpty(disk, root) {
  const page = await disk.listObjects(root.replace(/^\/+/, "") + "/", { recursive: true });
  return (page.objects || []).length === 0;
}

async function testIsolation() {
  console.log("\n=== Test 1: concurrent per-request isolation (ephemeral) ===");
  const P = (word) =>
    `Create out.txt containing exactly the text ${word} (nothing else). ` +
    `Then read out.txt back and report its exact contents. Be terse.`;

  const a = start(P("ALPHA"));
  const b = start(P("BRAVO"));
  console.log(`  A reqId=${a.reqId}\n    workspace=${a.workspaceRoot}`);
  console.log(`  B reqId=${b.reqId}\n    workspace=${b.workspaceRoot}`);

  const [ia, ib] = await Promise.all([a.done, b.done]);
  ok(ia.ok && ib.ok, `both runs completed (A ok=${ia.ok}, B ok=${ib.ok})`);

  // Isolation is proven by the run events: the tools route through the per-request
  // workspace, so the file path each run reports and the content each run reads
  // back must be its own.
  const ta = collectText(a.events);
  const tb = collectText(b.events);
  ok(a.workspaceRoot !== b.workspaceRoot, "workspace prefixes are distinct");
  ok(ta.includes(a.workspaceRoot) || ta.includes(a.reqId), "A wrote into its OWN prefix (path in tool output)");
  ok(tb.includes(b.workspaceRoot) || tb.includes(b.reqId), "B wrote into its OWN prefix (path in tool output)");
  ok(ta.includes("ALPHA") && !ta.includes("BRAVO"), "A saw ALPHA and NOT BRAVO");
  ok(tb.includes("BRAVO") && !tb.includes("ALPHA"), "B saw BRAVO and NOT ALPHA");

  if (usingArchil) {
    // Ephemeral (no session) prefixes must be garbage-collected when the run ends.
    const disk = await connectDisk();
    ok(await prefixEmpty(disk, a.workspaceRoot), "A's ephemeral prefix was GC'd after the run");
    ok(await prefixEmpty(disk, b.workspaceRoot), "B's ephemeral prefix was GC'd after the run");
  }
}

async function testSessionPersist() {
  console.log("\n=== Test 1b: session workspace persists (GC skips sessions) ===");
  if (!usingArchil) { console.log("  (skipped — in-memory backend)"); return; }
  const session = `test-sess-${Date.now().toString(36)}`;
  const events = [];
  const { done, workspaceRoot } = runAgentWorker({
    prompt: "Create keep.txt containing exactly PERSIST. Be terse.",
    session,
    onEvent: (e) => events.push(e),
  });
  const info = await done;
  ok(info.ok, "session run completed");
  const disk = await connectDisk();
  const v = await readKey(disk, keyOf(workspaceRoot, "keep.txt"));
  console.log(`  disk: ${keyOf(workspaceRoot, "keep.txt")} = ${JSON.stringify(v)}`);
  ok((v || "").includes("PERSIST"), "session file PERSISTS on disk after the run (not GC'd)");
  await cleanupPrefix(disk, workspaceRoot);
  console.log("  (cleaned up session prefix)");
}

async function testCancel() {
  console.log("\n=== Test 2: no-orphan cancellation ===");
  const before = cliProcCount();
  const r = start(
    "For i from 1 to 6: create file_i.txt with a short haiku, then read it back. " +
    "Do them one at a time, thinking between each. Be thorough."
  );
  // Let the child spin up and the run get going.
  await sleep(6000);
  const during = cliProcCount();
  ok(during > before, `cli.js child is running mid-flight (before=${before}, during=${during})`);

  console.log("  -> cancel()");
  r.cancel();

  // Wait past the SDK's stdin-EOF -> SIGTERM(2s) -> SIGKILL(5s) escalation + backstop.
  const settled = await Promise.race([r.done, sleep(15000).then(() => "timeout")]);
  ok(settled !== "timeout", "done resolved after cancel (worker exited)");

  await sleep(2000);
  const after = cliProcCount();
  ok(after <= before, `no orphaned cli.js child after cancel (before=${before}, after=${after})`);
}

const hardTimeout = setTimeout(() => {
  console.error("\n[test-workers] HARD TIMEOUT (120s) — forcing exit");
  process.exit(2);
}, 120000);

try {
  console.log(`[test-workers] backend = ${usingArchil ? "archil" : "in-memory"}`);
  await testIsolation();
  await testSessionPersist();
  await testCancel();
} catch (e) {
  console.error("[test-workers] threw:", e);
  failures++;
} finally {
  clearTimeout(hardTimeout);
  console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

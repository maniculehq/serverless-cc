// agent-worker.mjs — runs ONE agent request inside its own worker thread.
//
// Why a worker per request: under Vercel Fluid Compute a single warm instance
// serves multiple concurrent invocations, so module-level singletons (the old
// shared just-bash instance, one /workspace root) would be shared across
// requests. A node:worker_threads Worker gives each request its own JS VM +
// memory arena + event loop, so:
//   - the fs-backend / mcp-tools module singletons are naturally per-request
//     (a fresh module graph per worker), and
//   - the run is hard-cancellable: terminating the worker would ORPHAN the
//     spawned cli.js child (verified), so instead the parent posts {__cmd:"abort"}
//     and we call abortController.abort() HERE, inside the live worker — the SDK
//     then ends the child's stdin, SIGTERMs after ~2s and SIGKILLs after ~5s.
//
// Data isolation is layered on top: this worker scopes the workspace to a
// per-request prefix (CC_WORKSPACE = workspaceRoot) BEFORE importing the
// fs-backend, so two concurrent workers writing to the same Archil disk never
// collide on the same keys.
//
// The worker speaks a tiny message protocol to the parent (all plain JSON, which
// structured-clones losslessly):
//   parent -> worker : { __cmd: "abort" }
//   worker -> parent : NDJSON-shaped events { t: "init"|"text"|"text_delta"|
//                       "reasoning"|"reasoning_delta"|"tool_use"|"tool_result"|
//                       "result"|"error" , ... }  then a final { __exit: true }

import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";

const { prompt, cli, workspaceRoot, home, toolNames, hasSession } = workerData;

// Scope this worker's module graph (fs-backend reads CC_WORKSPACE at import time)
// and the agent's shell to a per-request prefix.
process.env.CC_WORKSPACE = workspaceRoot;

const post = (o) => {
  try { parentPort.postMessage(o); } catch { /* port closed */ }
};

// Cancellation: the parent posts {__cmd:"abort"} and we abort HERE (in the live
// worker) so the SDK can tear down its child cleanly. Terminating the worker
// from the parent without this would leave the cli.js child orphaned.
const ac = new AbortController();
parentPort.on("message", (m) => {
  if (m && m.__cmd === "abort") {
    try { ac.abort(); } catch { /* already aborted */ }
  }
});

// Built-in tools are disabled; every file/shell op must go through the
// mcp__workspace__* tools so it lands on the isolated just-bash + Archil backend.
const DISABLED = [
  "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit",
  "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS",
];

// The model uses bare tool names (Bash/Read/…); the mcp__workspace__ prefix is an
// internal routing detail re-added at the API boundary. Strip it from everything we
// surface to the UI so the transcript never shows it — including the ToolSearch
// call's `select:` query and its tool_reference results.
const WS_PREFIX = "mcp__workspace__";
function scrubPrefix(v) {
  if (typeof v === "string") return v.split(WS_PREFIX).join("");
  if (Array.isArray(v)) return v.map(scrubPrefix);
  if (v && typeof v === "object") {
    const o = {};
    for (const k in v) o[k] = scrubPrefix(v[k]);
    return o;
  }
  return v;
}

// Tool results arrive as a string or an array of content blocks; flatten to text.
function flattenToolResult(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && b.type === "text") return String(b.text ?? "");
        return JSON.stringify(b);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

async function main() {
  // Real host dir for the child's cwd / HOME (the workspace itself lives on the
  // Archil disk via just-bash, not the host fs).
  try { fs.mkdirSync(home, { recursive: true }); } catch { /* exists */ }

  // Dynamic imports: resolved at runtime inside the thread. The SDK comes from
  // node_modules (externalized); mcp-tools/fs-backend are app .mjs shipped via
  // outputFileTracingIncludes. fs-backend reads CC_WORKSPACE (set above) at eval.
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const { workspaceServer } = await import("./mcp-tools.mjs");

  let final = null;
  let isError = false;

  const q = query({
    prompt,
    options: {
      executable: "bun",
      pathToClaudeCodeExecutable: cli,
      cwd: home,
      abortController: ac,
      mcpServers: { workspace: workspaceServer },
      allowedTools: toolNames,
      disallowedTools: DISABLED,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      includePartialMessages: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          "Your Bash, Read, Write, Edit and LS tools operate on an isolated workspace filesystem rooted at " +
          workspaceRoot +
          " — NOT the host machine. Use them as you normally would; all file and shell work happens there.",
      },
      env: { ...process.env, HOME: home },
      stderr: (d) => { if (process.env.CC_DEBUG) post({ t: "stderr", text: String(d) }); },
    },
  });

  // includePartialMessages streams token-level deltas; when they arrive we stream
  // them and skip the (duplicate) text on the complete assistant message.
  let partialActive = false;

  for await (const m of q) {
    if (m.type === "stream_event") {
      const ev = m.event;
      if (ev?.type === "content_block_delta") {
        const d = ev.delta;
        if (d?.type === "text_delta" && d.text) {
          partialActive = true;
          post({ t: "text_delta", text: d.text });
        } else if (d?.type === "thinking_delta" && d.thinking) {
          partialActive = true;
          post({ t: "reasoning_delta", text: d.thinking });
        }
      }
    } else if (m.type === "system" && m.subtype === "init") {
      post({ t: "init", model: m.model });
    } else if (m.type === "assistant") {
      for (const c of m.message.content) {
        if (c.type === "text") {
          if (!partialActive && c.text) post({ t: "text", text: c.text });
        } else if (c.type === "thinking") {
          if (!partialActive && c.thinking && c.thinking.trim()) post({ t: "reasoning", text: c.thinking });
        } else if (c.type === "tool_use") {
          post({ t: "tool_use", id: c.id, name: scrubPrefix(c.name), input: scrubPrefix(c.input) });
        }
      }
    } else if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const c of m.message.content) {
        if (c.type === "tool_result") {
          const raw = scrubPrefix(flattenToolResult(c.content));
          post({ t: "tool_result", id: c.tool_use_id, text: raw.slice(0, 8000), is_error: !!c.is_error });
        }
      }
    } else if (m.type === "result") {
      final = m.result ?? null;
      isError = !!m.is_error;
    }
  }

  post({ t: "result", ok: !isError, final });
}

let failed = false;
main()
  .catch((e) => {
    failed = true;
    post({ t: "error", error: e instanceof Error ? e.message : String(e), aborted: ac.signal.aborted });
  })
  .finally(async () => {
    // Ephemeral workspace GC: a request without an explicit session got a
    // throwaway /workspace/<reqId> prefix; delete it so per-request prefixes
    // don't accumulate on the disk. (A session is meant to persist — leave it.)
    if (!hasSession && process.env.ARCHIL_API_KEY) {
      try {
        const { getBash } = await import("./fs-backend.mjs");
        const bash = await getBash();
        await bash.fs.rm(workspaceRoot, { recursive: true, force: true });
      } catch { /* best-effort */ }
    }
    // Carry the run's success flag so the parent resolves done.ok correctly
    // (main()'s catch swallows errors, so worker.on("error") never fires here).
    post({ __exit: true, ok: !failed, aborted: ac.signal.aborted });
    // Let the worker self-exit instead of relying solely on the parent's
    // terminate(): drop the message listener so the event loop can drain.
    try { parentPort.removeAllListeners("message"); parentPort.unref(); } catch { /* ok */ }
  });

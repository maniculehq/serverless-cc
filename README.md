# serverless-cc

> **This project is for research and educational purposes only. Claude and Claude Code are exclusive property of Anthropic PBC and/or its affiliates.**

A **Next.js** app (chat UI built with **shadcn/ui** + **Vercel AI Elements**) that drives
the **extracted Claude Code bundle** on **Vercel Fluid Compute (Bun runtime)**, with every
shell/file operation routed to **[just-bash](https://www.npmjs.com/package/just-bash)** over
a persistent **[Archil](https://archil.com)** disk.

```
Browser UI (app/page.tsx + components/chat.tsx — AI Elements, no AI SDK)
        │  POST /api/agent {prompt}              ▲  NDJSON event stream
        ▼                                        │  (text/reasoning deltas, tool calls)
   app/api/agent/route.ts — App Router handler, runs on the BUN runtime (vercel.json bunVersion)
        │  runAgentWorker()  (one per request)
        ▼
   lib/agent-worker.mjs — a node:worker_threads Worker (own JS VM + per-request workspace)
        │                        postMessage({t:...}) events ▲
   Agent SDK  ──spawns──▶  bin/cli.js (extracted Claude Code)   built-in tools DISABLED
        │                        │
        │  control protocol      ▼ tool calls
        └───────────────▶ mcp__workspace__{bash,read_file,write_file,edit_file,ls}
                                 │  (run in the WORKER process)
                                 ▼
                         per-request just-bash instance
                                 │
                                 ▼
                         DiskFs ──HTTPS──▶ this USER's Archil disk (cc-u-<hash>)  /workspace/…
```

The backend lives **inside Next.js** as an App Router route handler (not a root `/api`
function — that collides with Next's `/api/*` namespace). It still runs on **Bun** because
`vercel.json` sets `"bunVersion": "1.x"` globally. The handler streams the run as **NDJSON**
(one JSON event per line: `text_delta` / `reasoning_delta` / `tool_use` / `tool_result` /
`result`), and the UI consumes it with a plain `fetch` + `ReadableStream` reader and accumulates
the deltas — **no Vercel AI SDK / `useChat`** (AI Elements are used purely as presentational
components; `includePartialMessages: true` gives token-level streaming).

The bundle's own `Bash`/`Read`/`Write`/`Edit`/`Glob`/`Grep` are disabled; the model
uses custom MCP tools instead, all backed by a `just-bash` instance whose filesystem is the
Archil disk (`DiskFs`, via the pure-HTTPS `disk` SDK). If `ARCHIL_API_KEY` is unset it
falls back to an in-memory fs (handy for local dev).

### Worker isolation per request

Vercel Fluid Compute serves **multiple concurrent invocations from one warm instance**, so
module-level singletons (one shared `just-bash`, one `/workspace`) would be shared across
requests. Each `POST` therefore runs in its **own `node:worker_threads` Worker**
(`lib/agent-worker.mjs`, spawned by `lib/agent-runner.mjs`), which buys three things:

- **Compute isolation** — each Worker is its own JavaScriptCore VM + memory arena + event
  loop, so the `fs-backend`/`mcp-tools` module state is naturally per-request.
- **Data isolation** — every signed-in user gets their **own Archil disk**, auto-provisioned
  on first use and named `cc-u-<hash of the Better Auth user id>` (`lib/user-disk.mjs`). The
  route resolves the user's disk id on the main thread and hands it to the worker via
  `CC_DISK_ID` (set before importing `fs-backend`), which binds `DiskFs` to that disk. So
  cross-user isolation is at the **disk** level, and each user's `/workspace` is **persistent**
  — files survive across prompts and sessions. (When no per-user disk is bound — the local CLI
  or `scripts/test-workers.mjs` falling back to the shared `ARCHIL_DISK` — the worker keeps the
  old per-request `/workspace/<reqId>` prefix and GCs it when the run ends.)
- **Hard cancellation** — on client disconnect or the `maxDuration` deadline the route calls
  `cancel()`, which posts `{__cmd:"abort"}` to the worker; the worker aborts the SDK's
  `AbortController` *from inside the live thread* (stdin-EOF → SIGTERM → SIGKILL), reliably
  reaping the `cli.js` child. (`worker.terminate()` alone **orphans** the child — verified —
  so it's only used as a backstop after the child is already dead.)

Why not `node:vm`? A `vm` context shares the host heap/event-loop/builtins, isn't a sandbox,
and its `timeout` only bounds *synchronous* code — it can't cancel an async agent run. A
Worker is the primitive that actually isolates and can be killed. `scripts/test-workers.mjs`
exercises both properties (concurrent on-disk isolation + no-orphan cancellation).

## Layout

| Path | Purpose |
|---|---|
| `app/api/agent/route.ts` | The Bun route handler (`GET` health, `POST` streams a run as NDJSON) |
| `app/page.tsx` / `app/layout.tsx` | The page shell + header/status pill |
| `components/chat.tsx` | Chat UI: drives AI Elements with plain React state + a fetch stream reader |
| `components/status-pill.tsx` | Backend health badge (reads `GET /api/agent`) |
| `components/ai-elements/*` | Vercel AI Elements (conversation, message, prompt-input, tool, reasoning) |
| `components/ui/*` | shadcn/ui primitives |
| `lib/agent-worker.mjs` | The per-request Worker: runs `query()`, scopes the workspace, streams events, cancels + GC's |
| `lib/agent-runner.mjs` | Main-thread glue: spawns the Worker, abort-then-terminate cancel, concurrency cap |
| `lib/mcp-tools.mjs` | The `mcp__workspace__*` tools (Bash/Read/Write/Edit/LS — drop-in for the native tools) |
| `lib/fs-backend.mjs` | The per-worker `just-bash` instance; binds the user's disk via `CC_DISK_ID` (else shared `ARCHIL_DISK`), or `InMemoryFs` |
| `lib/user-disk.mjs` | Per-user disk provisioning: deterministic naming, idempotent create-or-get + wait, in-flight cache, cleanup |
| `lib/disk-fs.mjs` | just-bash `IFileSystem` over the Archil `disk` SDK object ops |
| `lib/utils.ts` | shadcn `cn()` helper |
| `bin/cli.js` | The extracted Claude Code bundle (16 MB) |
| `scripts/extract.py` | Carves `cli.js` out of a Claude Code standalone binary |
| `scripts/test-workers.mjs` | Worker tests: concurrent isolation + GC, session persistence, no-orphan cancel |
| `scripts/prune-disks.mjs` | Reconciler: deletes orphan `cc-u-*` disks with no live user (backstop for the auth delete hook) |
| `vercel.json` | `bunVersion: 1.x`, `fluid: true` (per-route `maxDuration` is in `route.ts`) |
| `next.config.ts` | `serverExternalPackages` + `outputFileTracingIncludes` (ships `bin/**` + `lib/**`) |
| `local.mjs` | Run the agent pipeline from the CLI directly (no Worker, no UI) — a debug baseline |
| `deploy.sh` | Deploy via `vc`, passing `.env` secrets as runtime env |

## Where `bin/cli.js` comes from

Claude Code is distributed as a `bun build --compile` **standalone executable**
(~250 MB) = the Bun runtime + an embedded payload. `scripts/extract.py` pulls the
app out of that binary so it can run on a stock Bun (the heavy embedded runtime is
discarded — `bin/cli.js` is only 16 MB).

How it works:

- A compiled Bun binary appends its payload after the real executable — inside the
  `__BUN,__bun` Mach-O segment on macOS, or tacked onto the end of the ELF on
  Linux — terminated by the trailer magic `\n---- Bun! ----\n`.
- The payload's **entry point is a single CommonJS file** marked
  `// @bun @bytecode @bun-cjs`, and Bun stores it as **readable source** (the
  bytecode is a parallel cache a stock Bun ignores and recompiles from source).
- So the script doesn't need to parse Bun's module table at all — it scans the
  whole binary for the **largest contiguous run of printable bytes that begins with
  `// @bun`** and carves that out as `cli.js`. It also prints an inventory (Bun
  version, `$bunfs/root/*` assets, count of bundled modules, sha/offset/length).
- That carved file is what the Agent SDK launches here: `bun bin/cli.js`. The five
  native `.node` addons and the embedded ripgrep stay behind in the original binary
  — they're unused because we disable the built-in tools and route everything to
  just-bash instead.

Regenerate it from a binary (e.g. to bump the Claude Code version):

```bash
python3 scripts/extract.py /path/to/claude-code-binary bin
# writes bin/cli.js and prints: bun 1.3.14 (…), cli_len 16814932, cli_sha …
node scripts/patch-cli.mjs   # re-applies the workspace tool-rename shim
```

This is automated: **`.github/workflows/update-claude-code.yml`** runs daily,
compares `@anthropic-ai/claude-code@latest` on npm against `bin/cli.js.version`,
and — when there's a new release — downloads the Linux x64 standalone binary,
re-runs the two steps above, smoke-tests the result, and pushes the bumped
`bin/cli.js` to `main`.

## Setup

```bash
bun install
cp .env.example .env   # fill in ARCHIL_* and ANTHROPIC_API_KEY
```

`.env` is git-ignored. Required vars (see `.env.example`): `ARCHIL_API_KEY`
(account `key-…`, not a disk `adt_…` token), `ARCHIL_REGION`, and `ANTHROPIC_API_KEY`
(or `CLAUDE_CODE_OAUTH_TOKEN`). `ARCHIL_DISK` (`account/disk`) is **optional** — each
signed-in user gets their own auto-provisioned disk; the shared disk is only a fallback
for the local CLI and `scripts/test-workers.mjs`.

## Run locally

Start the Next.js dev server and open the chat UI at http://localhost:3000:

```bash
bun run dev
```

Next loads `.env` automatically, so it uses the Archil disk if `ARCHIL_API_KEY` is set.
To force the self-contained in-memory backend (no Archil, no network), blank that var —
Next won't override an already-set environment variable:

```bash
ARCHIL_API_KEY="" bun run dev
```

Or run the same agent pipeline headless from the CLI (no UI):

```bash
bun run local "Create /workspace/notes.md with a TODO list, then read it back."
```

Build a production bundle with `bun run build`.

## Deploy

```bash
bash deploy.sh          # preview
bash deploy.sh --prod   # production
```

`deploy.sh` sources `.env` and passes the secrets as per-deploy `--env` flags. To
make them permanent project env vars instead, use `vc env add <NAME> production`.

### Call the deployed function

```bash
# health
vc curl https://<deployment>/api/agent
# run a prompt
vc curl https://<deployment>/api/agent -X POST \
  -H 'content-type: application/json' \
  -d '{"prompt":"echo hi > /workspace/x.txt && cat /workspace/x.txt"}'
```

`vc curl` attaches a Vercel deployment-protection bypass token automatically.

## Notes

- The `disk` SDK is pure HTTPS (no native deps); `@archildata/native`'s mount
  client is **not** used (its rustls build panics on TLS init under any JS runtime).
- just-bash's `defenseInDepth` is disabled because its `process.env` trap blocks
  the Vercel runtime's fetch instrumentation during `DiskFs` HTTPS calls. The real
  isolation is the Archil disk + just-bash's limited command set.
- The SDK spawns the `bun` runtime by name; the handler symlinks `process.execPath`
  to `/tmp/bin/bun` and prepends it to `PATH` so that resolves inside the function.

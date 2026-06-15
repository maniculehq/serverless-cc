// Next.js App Router route handler — runs on the BUN runtime on Vercel (set via
// `bunVersion` in vercel.json; do NOT add `export const runtime = "edge"`).
//
// This is the same pipeline as the old standalone api/agent.mjs: it drives the
// EXTRACTED Claude Code bundle (bin/cli.js) via the Agent SDK, with the bundle's
// built-in shell/file tools disabled. Every tool call routes to our
// mcp__workspace__* tools, backed by one just-bash instance over the Archil disk
// (DiskFs) — or an in-memory fs when ARCHIL_API_KEY is unset.
//
// POST streams the run as NDJSON (one JSON event per line) so the UI can show
// text, tool calls and tool results live. GET is a health check.

import { query } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import fs from "node:fs";
import { workspaceServer, TOOL_NAMES } from "../../../lib/mcp-tools.mjs";

export const runtime = "nodejs"; // becomes Bun on Vercel via vercel.json bunVersion
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The Agent SDK's Options type is large and evolving; we pass the same shape the
// standalone function used. Treat `query` loosely so the route stays decoupled
// from SDK type churn, and iterate messages as untyped events.
// biome-ignore lint/suspicious/noExplicitAny: SDK messages are dynamic; iterated loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMsg = Record<string, any>;
const runQuery = query as unknown as (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<AnyMsg>;

const bunVersion = () => (process.versions as { bun?: string }).bun;

// Tool results arrive as either a string or an array of content blocks
// ({type:"text", text}). Flatten to clean text for display.
function flattenToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
          return String((b as { text?: string }).text ?? "");
        }
        return JSON.stringify(b);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

const CLI = process.env.CC_CLI || path.join(process.cwd(), "bin", "cli.js");
const DISABLED = [
  "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit",
  "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS",
];

// The Agent SDK spawns the runtime by name ("bun"), which isn't on PATH inside
// the Vercel function environment. We run UNDER bun (process.execPath), so expose it
// as `/tmp/bin/bun` and prepend that dir to PATH so the SDK's spawn resolves it.
function ensureBunOnPath(): string {
  try {
    if (!bunVersion()) return "not-bun:" + process.execPath;
    const binDir = "/tmp/bin";
    fs.mkdirSync(binDir, { recursive: true });
    const link = path.join(binDir, "bun");
    try { fs.unlinkSync(link); } catch {}
    fs.symlinkSync(process.execPath, link);
    const parts = (process.env.PATH || "").split(":");
    if (!parts.includes(binDir)) process.env.PATH = binDir + ":" + (process.env.PATH || "");
    return link + " -> " + process.execPath;
  } catch (e: unknown) {
    return "ERR:" + (e instanceof Error ? e.message : String(e));
  }
}
const BUN_LINK = ensureBunOnPath();

export function GET() {
  return Response.json({
    ok: true,
    service: "cc-archil",
    backend: process.env.ARCHIL_API_KEY
      ? "archil:" + (process.env.ARCHIL_DISK || "")
      : "in-memory",
    cliExists: fs.existsSync(CLI),
    anthropic: !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN),
    runtime: bunVersion() ? "bun " + bunVersion() : "node " + process.versions.node,
    bunLink: BUN_LINK,
  });
}

export async function POST(request: Request) {
  let body: { prompt?: string } = {};
  try { body = await request.json(); } catch {}
  const prompt = body?.prompt;
  if (!prompt || !prompt.trim()) {
    return Response.json({ ok: false, error: "missing 'prompt'" }, { status: 400 });
  }

  ensureBunOnPath(); // re-assert (instance reuse / /tmp churn)
  const HOME = "/tmp/cchome";
  try { fs.mkdirSync(HOME, { recursive: true }); } catch {}

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try { controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n")); } catch {}
      };

      let final: string | null = null;
      let isError = false;

      try {
        const q = runQuery({
          prompt,
          options: {
            executable: "bun",
            pathToClaudeCodeExecutable: CLI,
            cwd: "/tmp",
            mcpServers: { workspace: workspaceServer },
            allowedTools: TOOL_NAMES,
            disallowedTools: DISABLED,
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            settingSources: [],
            includePartialMessages: true, // token-level text/thinking deltas
            systemPrompt: {
              type: "preset",
              preset: "claude_code",
              append:
                "All file and shell operations MUST go through the mcp__workspace__* tools (bash, read_file, write_file, edit_file, ls). Built-in Bash/Read/Write/Edit are unavailable. Workspace root is /workspace.",
            },
            env: { ...process.env, HOME },
          },
        });

        // When includePartialMessages yields stream_event deltas we stream text
        // token-by-token and SKIP the (duplicate) text in the complete assistant
        // message. If no deltas ever arrive (older bundle), partialActive stays
        // false and we fall back to emitting whole assistant text blocks.
        let partialActive = false;

        for await (const m of q) {
          if (m.type === "stream_event") {
            const ev = m.event;
            if (ev?.type === "content_block_delta") {
              const d = ev.delta;
              if (d?.type === "text_delta" && d.text) {
                partialActive = true;
                send({ t: "text_delta", text: d.text });
              } else if (d?.type === "thinking_delta" && d.thinking) {
                partialActive = true;
                send({ t: "reasoning_delta", text: d.thinking });
              }
            }
          } else if (m.type === "system" && m.subtype === "init") {
            send({ t: "init", model: m.model });
          } else if (m.type === "assistant") {
            for (const c of m.message.content) {
              if (c.type === "text") {
                if (!partialActive && c.text) send({ t: "text", text: c.text });
              } else if (c.type === "thinking") {
                if (!partialActive && c.thinking && c.thinking.trim()) {
                  send({ t: "reasoning", text: c.thinking });
                }
              } else if (c.type === "tool_use") {
                send({ t: "tool_use", id: c.id, name: c.name, input: c.input });
              }
            }
          } else if (m.type === "user" && Array.isArray(m.message?.content)) {
            for (const c of m.message.content) {
              if (c.type === "tool_result") {
                const raw = flattenToolResult(c.content);
                send({
                  t: "tool_result",
                  id: c.tool_use_id,
                  text: raw.slice(0, 8000),
                  is_error: !!c.is_error,
                });
              }
            }
          } else if (m.type === "result") {
            final = m.result ?? null;
            isError = !!m.is_error;
          }
        }
        send({ t: "result", ok: !isError, final });
      } catch (e: unknown) {
        send({ t: "error", error: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

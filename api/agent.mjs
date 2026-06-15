// Vercel Function (Bun runtime, Fluid Compute): drives the EXTRACTED Claude Code
// bundle via the Agent SDK. The bundle's built-in shell/file tools are disabled;
// all tool calls route to our mcp__sandbox__* tools, backed by one just-bash
// instance over the Archil disk (DiskFs) — or in-memory if ARCHIL_API_KEY unset.
// Plain ESM (.mjs) so Vercel skips the TS typecheck step.
import { query } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import fs from "node:fs";
import { sandboxServer, TOOL_NAMES } from "../lib/mcp-tools.mjs";

export const config = { maxDuration: 300 };

const CLI = path.join(process.cwd(), "bin", "cli.js");
const DISABLED = ["Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS"];

// The Agent SDK spawns the runtime by name ("bun"), which isn't on PATH inside
// the Vercel function sandbox. We run UNDER bun (process.execPath), so expose it
// as `/tmp/bin/bun` and prepend that dir to PATH so the SDK's spawn resolves it.
function ensureBunOnPath() {
  try {
    if (!process.versions?.bun) return "not-bun:" + process.execPath;
    const binDir = "/tmp/bin";
    fs.mkdirSync(binDir, { recursive: true });
    const link = path.join(binDir, "bun");
    try { fs.unlinkSync(link); } catch {}
    fs.symlinkSync(process.execPath, link);
    const parts = (process.env.PATH || "").split(":");
    if (!parts.includes(binDir)) process.env.PATH = binDir + ":" + (process.env.PATH || "");
    return link + " -> " + process.execPath;
  } catch (e) { return "ERR:" + (e?.message || e); }
}
const BUN_LINK = ensureBunOnPath();

export function GET() {
  return Response.json({
    ok: true,
    service: "cc-archil",
    backend: process.env.ARCHIL_API_KEY ? "archil:" + (process.env.ARCHIL_DISK || "") : "in-memory",
    cliExists: fs.existsSync(CLI),
    anthropic: !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN),
    runtime: process.versions?.bun ? "bun " + process.versions.bun : "node " + process.versions.node,
    bunLink: BUN_LINK,
  });
}

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch {}
  const prompt = body?.prompt;
  if (!prompt) return Response.json({ ok: false, error: "missing 'prompt'" }, { status: 400 });

  ensureBunOnPath(); // re-assert (instance reuse / /tmp churn)
  const HOME = "/tmp/cchome";
  try { fs.mkdirSync(HOME, { recursive: true }); } catch {}

  const events = [];
  let final = null;
  let isError = false;

  try {
    const q = query({
      prompt,
      options: {
        executable: "bun",
        pathToClaudeCodeExecutable: CLI,
        cwd: "/tmp",
        mcpServers: { sandbox: sandboxServer },
        allowedTools: TOOL_NAMES,
        disallowedTools: DISABLED,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: "All file and shell operations MUST go through the mcp__sandbox__* tools (bash, read_file, write_file, edit_file, ls). Built-in Bash/Read/Write/Edit are unavailable. Workspace root is /workspace.",
        },
        env: { ...process.env, HOME },
      },
    });

    for await (const m of q) {
      if (m.type === "assistant") {
        for (const c of m.message.content) {
          if (c.type === "text") events.push({ t: "text", text: c.text });
          else if (c.type === "tool_use") events.push({ t: "tool_use", name: c.name, input: c.input });
        }
      } else if (m.type === "user" && Array.isArray(m.message?.content)) {
        for (const c of m.message.content) {
          if (c.type === "tool_result") {
            const t = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
            events.push({ t: "tool_result", text: t.slice(0, 600) });
          }
        }
      } else if (m.type === "result") { final = m.result ?? null; isError = !!m.is_error; }
    }
    return Response.json({ ok: !isError, final, events });
  } catch (e) {
    return Response.json({ ok: false, error: String(e?.message || e), stack: String(e?.stack || "").slice(0, 2000), events }, { status: 500 });
  }
}

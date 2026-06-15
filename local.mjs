// Local runner: same pipeline as the Vercel function, run from the CLI.
//   bun run --env-file=.env local.mjs "your prompt"
// (or: bun run local "your prompt")
//
// Drives the extracted Claude Code bundle (bin/cli.js) via the Agent SDK with
// the built-in shell/file tools disabled; all tool calls route to the custom
// mcp__workspace__* tools, backed by one just-bash instance over the Archil disk
// (when ARCHIL_API_KEY is set) or an in-memory fs otherwise.
import { query } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { workspaceServer, TOOL_NAMES } from "./lib/mcp-tools.mjs";
import { backendLabel, WORKSPACE, shutdown } from "./lib/fs-backend.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = process.env.CC_CLI || path.join(HERE, "bin", "cli.js");
const HOST_CWD = "/tmp/serverless-cc-cwd";
fs.mkdirSync(HOST_CWD, { recursive: true });

const DISABLED = ["Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS"];

const prompt = process.argv[2] ||
  `Create ${WORKSPACE}/hello.txt containing exactly 'hi from serverless-cc', read it back, then run 'ls -la ${WORKSPACE}'. Be terse.`;

console.log(`[local] backend = ${backendLabel()} | workspace = ${WORKSPACE}`);

const q = query({
  prompt,
  options: {
    executable: "bun",
    pathToClaudeCodeExecutable: CLI,
    cwd: HOST_CWD,
    mcpServers: { workspace: workspaceServer },
    allowedTools: TOOL_NAMES,
    disallowedTools: DISABLED,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: `All file and shell operations MUST go through the mcp__workspace__* tools (bash, read_file, write_file, edit_file, ls). Built-in Bash/Read/Write/Edit are unavailable. Workspace root is ${WORKSPACE}.`,
    },
    env: { ...process.env, HOME: HOST_CWD },
    stderr: (d) => { if (process.env.CC_DEBUG) process.stderr.write(d); },
  },
});

try {
  for await (const m of q) {
    if (m.type === "system" && m.subtype === "init") {
      console.log("INIT model=", m.model, "| mcp tools:", (m.tools || []).filter((t) => t.startsWith("mcp__workspace__")).join(", "));
    } else if (m.type === "assistant") {
      for (const c of m.message.content) {
        if (c.type === "text") console.log("ASSISTANT:", c.text);
        else if (c.type === "tool_use") console.log(`TOOL_USE[${c.name}]:`, JSON.stringify(c.input));
      }
    } else if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const c of m.message.content) {
        if (c.type === "tool_result") {
          const t = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
          console.log("TOOL_RESULT:", t.slice(0, 400));
        }
      }
    } else if (m.type === "result") {
      console.log("RESULT:", m.subtype, "| is_error:", m.is_error);
      if (m.result) console.log("FINAL:", m.result);
    }
  }
} finally {
  await shutdown();
}

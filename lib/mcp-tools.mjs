// mcp-tools.mjs — the agent's tools, ALL backed by one just-bash instance
// (InMemoryFs locally, ArchilFs when credentials are set). These run in the SDK
// host process; the extracted binary calls them over the control protocol.
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getBash, withWriteDelegation, WORKSPACE, shq } from "./fs-backend.mjs";

const abs = (p) => (p && p.startsWith("/") ? p : `${WORKSPACE}/${p || ""}`);
const text = (s) => ({ content: [{ type: "text", text: s }] });
const err = (s) => ({ content: [{ type: "text", text: s }], isError: true });

const bashTool = tool(
  "bash",
  "Run a bash command in the isolated workspace shell (just-bash). Returns stdout, stderr and exit code. The workspace root is " + WORKSPACE + ".",
  { command: z.string().describe("The shell command to run"), cwd: z.string().optional().describe("Working directory (defaults to the workspace root)") },
  async ({ command, cwd }) => {
    const bash = await getBash();
    const r = await bash.exec(command, { cwd: cwd ? abs(cwd) : WORKSPACE });
    const parts = [];
    if (r.stdout) parts.push(r.stdout.replace(/\n$/, ""));
    if (r.stderr) parts.push("[stderr] " + r.stderr.replace(/\n$/, ""));
    parts.push(`[exit ${r.exitCode}]`);
    return r.exitCode === 0 ? text(parts.join("\n")) : err(parts.join("\n"));
  }
);

const readTool = tool(
  "read_file",
  "Read a text file from the workspace filesystem.",
  { path: z.string().describe("Absolute or workspace-relative file path") },
  async ({ path }) => {
    const bash = await getBash();
    try { return text(await bash.fs.readFile(abs(path))); }
    catch (e) { return err(`read_file failed: ${e.message}`); }
  }
);

const writeTool = tool(
  "write_file",
  "Create or overwrite a text file in the workspace filesystem.",
  { path: z.string().describe("Absolute or workspace-relative file path"), content: z.string().describe("Full file contents") },
  async ({ path, content }) => {
    const bash = await getBash();
    const p = abs(path);
    const dir = p.slice(0, p.lastIndexOf("/")) || "/";
    try {
      await bash.fs.mkdir(dir, { recursive: true }).catch(() => {});
      await withWriteDelegation(bash, dir, () => bash.fs.writeFile(p, content));
      return text(`Wrote ${content.length} bytes to ${p}`);
    } catch (e) { return err(`write_file failed: ${e.message}`); }
  }
);

const editTool = tool(
  "edit_file",
  "Replace an exact substring in a file. old_string must appear exactly once.",
  {
    path: z.string().describe("Absolute or workspace-relative file path"),
    old_string: z.string().describe("Exact text to replace"),
    new_string: z.string().describe("Replacement text"),
  },
  async ({ path, old_string, new_string }) => {
    const bash = await getBash();
    const p = abs(path);
    try {
      const cur = await bash.fs.readFile(p);
      const n = cur.split(old_string).length - 1;
      if (n === 0) return err("edit_file failed: old_string not found");
      if (n > 1) return err(`edit_file failed: old_string appears ${n} times (must be unique)`);
      const next = cur.replace(old_string, new_string);
      const dir = p.slice(0, p.lastIndexOf("/")) || "/";
      await withWriteDelegation(bash, dir, () => bash.fs.writeFile(p, next));
      return text(`Edited ${p}`);
    } catch (e) { return err(`edit_file failed: ${e.message}`); }
  }
);

const lsTool = tool(
  "ls",
  "List a directory in the workspace filesystem.",
  { path: z.string().optional().describe("Directory (defaults to workspace root)") },
  async ({ path }) => {
    const bash = await getBash();
    const r = await bash.exec(`ls -la ${shq(abs(path || "."))}`, { cwd: WORKSPACE });
    return r.exitCode === 0 ? text(r.stdout || "(empty)") : err(r.stderr || `exit ${r.exitCode}`);
  }
);

export const TOOL_NAMES = [
  "mcp__workspace__bash",
  "mcp__workspace__read_file",
  "mcp__workspace__write_file",
  "mcp__workspace__edit_file",
  "mcp__workspace__ls",
];

export const workspaceServer = createSdkMcpServer({
  name: "workspace",
  version: "0.1.0",
  tools: [bashTool, readTool, writeTool, editTool, lsTool],
});

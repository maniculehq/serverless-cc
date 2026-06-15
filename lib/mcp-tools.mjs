// mcp-tools.mjs — the agent's tools, ALL backed by one just-bash instance
// (InMemoryFs locally, ArchilFs when credentials are set). These run in the SDK
// host process; the extracted binary calls them over the control protocol.
//
// The schemas + outputs here are aligned with Claude Code's BUILT-IN tools
// (Bash / Read / Write / Edit / LS): same parameter names (`file_path`,
// `offset`, `limit`, `replace_all`, `ignore`, …) and the same output shapes
// (cat -n line numbering on read, edit snippets, ls trees). Extra built-in
// params we don't fully implement (`description`, `timeout`,
// `run_in_background`) are still accepted so the model can pass them without
// triggering a validation error.
import path from "node:path";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getBash, withWriteDelegation, WORKSPACE } from "./fs-backend.mjs";

const abs = (p) =>
  path.posix.normalize(p && p.startsWith("/") ? p : `${WORKSPACE}/${p || ""}`);
const text = (s) => ({ content: [{ type: "text", text: s }] });
const err = (s) => ({ content: [{ type: "text", text: s }], isError: true });

// --- formatting helpers (match the built-in tools) -----------------------

const LINE_W = 6; // cat -n right-justifies line numbers in a 6-char field
const MAX_LINE = 2000; // built-in Read truncates very long lines

const fmtLine = (n, line) =>
  `${String(n).padStart(LINE_W)}\t${line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line}`;

// Split into logical lines, dropping the spurious trailing "" from a final \n
// so numbering matches `cat -n`.
function splitLines(content) {
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function pathExists(bash, p) {
  if (typeof bash.fs.exists === "function") {
    try { return await bash.fs.exists(p); } catch { return false; }
  }
  try { await bash.fs.stat(p); return true; } catch { return false; }
}

// Prefer readdirWithFileTypes; fall back to readdir + stat.
async function listDir(bash, dir) {
  if (typeof bash.fs.readdirWithFileTypes === "function") {
    return bash.fs.readdirWithFileTypes(dir);
  }
  const names = await bash.fs.readdir(dir);
  const out = [];
  for (const name of names) {
    let isDirectory = false;
    try { isDirectory = (await bash.fs.stat(`${dir}/${name}`)).isDirectory; } catch {}
    out.push({ name, isDirectory });
  }
  return out;
}

const globToRe = (glob) =>
  new RegExp(
    "^" +
      glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$"
  );

// cat -n snippet around the first occurrence of `inserted`, like built-in Edit.
function editSnippet(content, inserted) {
  const lines = splitLines(content);
  const idx = content.indexOf(inserted);
  if (idx < 0) return lines.slice(0, 20).map((l, i) => fmtLine(i + 1, l)).join("\n");
  const startLine = content.slice(0, idx).split("\n").length; // 1-based
  const span = Math.max(1, splitLines(inserted).length);
  const ctx = 3;
  const from = Math.max(1, startLine - ctx);
  const to = Math.min(lines.length, startLine + span - 1 + ctx);
  const out = [];
  for (let n = from; n <= to; n++) out.push(fmtLine(n, lines[n - 1] ?? ""));
  return out.join("\n");
}

const LS_LIMIT = 200; // guard against deep recursion on the shared disk

async function walkTree(bash, dir, patterns, depth, acc) {
  if (acc.count >= LS_LIMIT) { acc.truncated = true; return; }
  let entries;
  try { entries = await listDir(bash, dir); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (acc.count >= LS_LIMIT) { acc.truncated = true; return; }
    if (e.name === ".keep" || patterns.some((re) => re.test(e.name))) continue;
    acc.lines.push(`${"  ".repeat(depth)}- ${e.name}${e.isDirectory ? "/" : ""}`);
    acc.count++;
    if (e.isDirectory) await walkTree(bash, `${dir}/${e.name}`, patterns, depth + 1, acc);
  }
}

// --- tools ---------------------------------------------------------------

// Bash: shape matches built-in Bash. `description`/`run_in_background` are
// accepted but not acted on; `timeout` is passed through best-effort. Unlike the
// built-in (which keeps one long-lived shell), just-bash does NOT persist cwd
// between calls, so each command runs rooted at the workspace — chain steps with
// `&&` when a directory change must carry within the same command.
const bashTool = tool(
  "Bash",
  "Executes a bash command in the isolated workspace shell. Each command runs from the workspace root (" + WORKSPACE + "); the working directory does not persist between calls, so chain steps with `&&` (e.g. `cd sub && ls`).",
  {
    command: z.string().describe("The command to execute"),
    description: z.string().optional().describe("Clear, concise description of what this command does in 5-10 words"),
    timeout: z.number().optional().describe("Optional timeout in milliseconds"),
    run_in_background: z.boolean().optional().describe("Set to true to run this command in the background"),
  },
  async ({ command, timeout }) => {
    const bash = await getBash();
    const opts = { cwd: WORKSPACE };
    if (typeof timeout === "number") opts.timeout = timeout;
    const r = await bash.exec(command, opts);
    const out = [r.stdout, r.stderr]
      .filter((s) => s != null && s !== "")
      .map((s) => s.replace(/\n$/, ""))
      .join("\n");
    return r.exitCode === 0 ? text(out) : err(out || `Command exited with code ${r.exitCode}`);
  }
);

// Read: cat -n output with line numbers; supports offset/limit like built-in Read.
const readTool = tool(
  "Read",
  "Reads a text file from the workspace filesystem. Results are returned using cat -n format, with line numbers starting at 1.",
  {
    file_path: z.string().describe("The absolute or workspace-relative path to the file to read"),
    offset: z.number().optional().describe("The line number to start reading from"),
    limit: z.number().optional().describe("The number of lines to read"),
  },
  async ({ file_path, offset, limit }) => {
    const bash = await getBash();
    try {
      const content = await bash.fs.readFile(abs(file_path));
      if (content === "") return text("(file is empty)");
      const lines = splitLines(content);
      const start = offset && offset > 0 ? Math.floor(offset) : 1;
      const max = limit && limit > 0 ? Math.floor(limit) : 2000;
      const slice = lines.slice(start - 1, start - 1 + max);
      if (slice.length === 0) return text(`(no content at offset ${start})`);
      return text(slice.map((line, i) => fmtLine(start + i, line)).join("\n"));
    } catch (e) {
      return err(`Read failed: ${e.message}`);
    }
  }
);

// Write: same params as built-in Write; create/overwrite confirmation message.
const writeTool = tool(
  "Write",
  "Writes a file to the workspace filesystem, overwriting it if it already exists.",
  {
    file_path: z.string().describe("The absolute or workspace-relative path to the file to write"),
    content: z.string().describe("The content to write to the file"),
  },
  async ({ file_path, content }) => {
    const bash = await getBash();
    const p = abs(file_path);
    const dir = p.slice(0, p.lastIndexOf("/")) || "/";
    try {
      const existed = await pathExists(bash, p);
      await bash.fs.mkdir(dir, { recursive: true }).catch(() => {});
      await withWriteDelegation(bash, dir, () => bash.fs.writeFile(p, content));
      return text(existed ? `The file ${p} has been updated.` : `File created successfully at: ${p}`);
    } catch (e) {
      return err(`Write failed: ${e.message}`);
    }
  }
);

// Edit: built-in Edit semantics — unique match by default, replace_all opt-in,
// and a cat -n snippet of the edited region echoed back.
const editTool = tool(
  "Edit",
  "Performs exact string replacement in a file. By default old_string must appear exactly once; set replace_all to replace every occurrence.",
  {
    file_path: z.string().describe("The absolute or workspace-relative path to the file to modify"),
    old_string: z.string().describe("The text to replace"),
    new_string: z.string().describe("The text to replace it with (must differ from old_string)"),
    replace_all: z.boolean().optional().describe("Replace all occurrences of old_string (default false)"),
  },
  async ({ file_path, old_string, new_string, replace_all }) => {
    const bash = await getBash();
    const p = abs(file_path);
    try {
      const cur = await bash.fs.readFile(p);
      const n = cur.split(old_string).length - 1;
      if (n === 0) return err("Edit failed: old_string not found in file");
      if (n > 1 && !replace_all) {
        return err(`Edit failed: old_string appears ${n} times; provide a larger unique string or set replace_all=true`);
      }
      const next = replace_all ? cur.split(old_string).join(new_string) : cur.replace(old_string, new_string);
      const dir = p.slice(0, p.lastIndexOf("/")) || "/";
      await withWriteDelegation(bash, dir, () => bash.fs.writeFile(p, next));
      return text(
        `The file ${p} has been edited. Here's the result of running \`cat -n\` on a snippet of the edited file:\n` +
          editSnippet(next, new_string)
      );
    } catch (e) {
      return err(`Edit failed: ${e.message}`);
    }
  }
);

// LS: built-in LS params (`path`, `ignore`); renders an indented tree.
const lsTool = tool(
  "LS",
  "Lists files and directories in the workspace filesystem as an indented tree.",
  {
    path: z.string().optional().describe("The absolute or workspace-relative directory path (defaults to the workspace root)"),
    ignore: z.array(z.string()).optional().describe("List of glob patterns to ignore"),
  },
  async ({ path: dirPath, ignore }) => {
    const bash = await getBash();
    const root = abs(dirPath || ".");
    const patterns = (ignore || []).map(globToRe);
    const acc = { lines: [], count: 0, truncated: false };
    try {
      await walkTree(bash, root, patterns, 1, acc);
    } catch (e) {
      return err(`LS failed: ${e.message}`);
    }
    const header = `- ${root.replace(/\/+$/, "")}/`;
    if (acc.lines.length === 0) return text(`${header}\n  (empty)`);
    let body = [header, ...acc.lines].join("\n");
    if (acc.truncated) body += `\n  … (truncated at ${LS_LIMIT} entries)`;
    return text(body);
  }
);

export const TOOL_NAMES = [
  "mcp__workspace__Bash",
  "mcp__workspace__Read",
  "mcp__workspace__Write",
  "mcp__workspace__Edit",
  "mcp__workspace__LS",
];

export const workspaceServer = createSdkMcpServer({
  name: "workspace",
  version: "0.1.0",
  tools: [bashTool, readTool, writeTool, editTool, lsTool],
});

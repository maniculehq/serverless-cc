#!/usr/bin/env node
// patch-cli.mjs — make the workspace MCP tools appear to the MODEL under the
// bare built-in names (Bash/Read/Write/Edit/LS) instead of mcp__workspace__*.
//
// Why a patch and not SDK config: SDK MCP tools are ALWAYS exposed as
// `mcp__<server>__<tool>` and that prefix is load-bearing inside the bundle
// (routing, permissions, display all key off `.startsWith("mcp__")`). Renaming
// internally would mean touching ~40 code paths. Instead we rewrite tool names
// ONLY at the Anthropic API boundary:
//   - outbound (cli -> API): strip the prefix so the model sees `Bash`, `Read`…
//   - inbound  (API -> cli): re-add the prefix on streamed tool_use names so the
//     bundle's own routing dispatches to the workspace MCP server unchanged.
//
// The rewrite is a tiny globalThis.fetch wrapper injected as the FIRST statement
// inside the bundle's CJS wrapper (so it runs before any sub-module captures
// fetch). It only ever touches our 5 exact tool-name strings — zero internal
// logic changes.
//
// Idempotent + re-appliable: run AFTER scripts/extract.py regenerates bin/cli.js.
//   node scripts/patch-cli.mjs [path-to-cli.js]

import fs from "node:fs";
import path from "node:path";

const CLI = process.argv[2] || path.join(process.cwd(), "bin", "cli.js");
const MARKER = "/*__WS_TOOL_RENAME__*/";

// Runs inside the bundle's CJS wrapper at module-eval time. Universal JS (no
// import/export, no template literals so it embeds cleanly here).
const SHIM = `${MARKER}(function(){try{
var P="mcp__workspace__",N=["Bash","Read","Write","Edit","LS"];
// outbound (cli->API): strip our prefix EVERYWHERE the model reads it — tool
// definitions, the deferred-tools catalog text, history tool_use + tool_reference.
function out(s){for(var i=0;i<N.length;i++){s=s.split(P+N[i]).join(N[i]);}return s;}
// inbound (API->cli) tool_use name: bare -> prefixed so the bundle routes the call
// to the workspace MCP server unchanged.
function fixName(s){for(var i=0;i<N.length;i++){s=s.split('"name":"'+N[i]+'"').join('"name":"'+P+N[i]+'"');}return s;}
// inbound ToolSearch select query: re-prefix our bare names so the bundle's own
// ToolSearch matches its real registered (prefixed) tool names.
function fixSelect(j){try{var o=JSON.parse(j);if(o&&typeof o.query==="string"&&o.query.indexOf("select:")===0){var parts=o.query.slice(7).split(",").map(function(t){var x=t.trim();return N.indexOf(x)!==-1?P+x:t;});o.query="select:"+parts.join(",");return JSON.stringify(o);}}catch(e){}return j;}
var DBG=!!(globalThis.process&&process.env&&process.env.WS_RENAME_DEBUG);
function url(x){try{if(typeof x==="string")return x;if(x&&x.url)return x.url;return String(x);}catch(e){return "";}}
function isMsg(u){return typeof u==="string"&&u.indexOf("/v1/messages")!==-1;}
var of=globalThis.fetch;
if(typeof of!=="function")return;
globalThis.fetch=async function(input,init){try{
var u=url(input);
if(isMsg(u)){
if(init&&typeof init.body==="string"){var nb=out(init.body);if(nb!==init.body){init=Object.assign({},init,{body:nb});if(DBG)console.error("[ws-rename] outbound scrubbed; residual prefix:",nb.indexOf(P)!==-1);}}
else if(input&&typeof input==="object"&&typeof input.clone==="function"&&typeof input.text==="function"&&(input.method||"GET").toUpperCase()==="POST"){try{var ob=await input.clone().text();var rb=out(ob);if(rb!==ob)input=new Request(input,{body:rb});}catch(e){}}
var res=await of(input,init);
if(res&&res.body){
var dec=new TextDecoder(),enc=new TextEncoder(),buf="",tsIdx={};
// SSE-event-aware transform (split on blank line). Most events pass through with
// the tool_use name fix; ToolSearch tool_use input is buffered across its
// input_json_delta fragments and re-emitted once, with the select query fixed.
var emit=function(ctrl,evt){
var dm=evt.match(/^data: (.*)$/m);
if(!dm){ctrl.enqueue(enc.encode(evt));return;}
var o=null;try{o=JSON.parse(dm[1]);}catch(e){}
if(o){
if(o.type==="content_block_start"&&o.content_block&&o.content_block.type==="tool_use"&&o.content_block.name==="ToolSearch"){tsIdx[o.index]="";ctrl.enqueue(enc.encode(evt));return;}
if(o.type==="content_block_delta"&&o.delta&&o.delta.type==="input_json_delta"&&(o.index in tsIdx)){tsIdx[o.index]+=(o.delta.partial_json||"");return;}
if(o.type==="content_block_stop"&&(o.index in tsIdx)){var full=fixSelect(tsIdx[o.index]);delete tsIdx[o.index];ctrl.enqueue(enc.encode("event: content_block_delta\\ndata: "+JSON.stringify({type:"content_block_delta",index:o.index,delta:{type:"input_json_delta",partial_json:full}})+"\\n\\n"));ctrl.enqueue(enc.encode(evt));if(DBG)console.error("[ws-rename] toolsearch select ->",full);return;}
}
ctrl.enqueue(enc.encode(fixName(evt)));
};
var ts=new TransformStream({transform:function(chunk,ctrl){buf+=dec.decode(chunk,{stream:true});var i;while((i=buf.indexOf("\\n\\n"))!==-1){var evt=buf.slice(0,i+2);buf=buf.slice(i+2);emit(ctrl,evt);}},flush:function(ctrl){if(buf){emit(ctrl,buf);buf="";}}});
var h=new Headers(res.headers);h.delete("content-encoding");h.delete("content-length");
return new Response(res.body.pipeThrough(ts),{status:res.status,statusText:res.statusText,headers:h});
}
return res;
}
}catch(e){if(globalThis.process&&process.env&&process.env.WS_RENAME_DEBUG)console.error("[ws-rename] error",e&&e.message);}
return of(input,init);
};
if(DBG)console.error("[ws-rename] fetch shim installed");
}catch(e){}})();
`;

function main() {
  if (!fs.existsSync(CLI)) {
    console.error(`patch-cli: not found: ${CLI}`);
    process.exit(1);
  }
  const src = fs.readFileSync(CLI, "utf8");
  if (src.includes(MARKER)) {
    console.log(`patch-cli: already patched (${CLI})`);
    return;
  }
  // Inject as the first statement inside the CJS wrapper, keeping the Bun
  // directive line (`// @bun @bytecode @bun-cjs`) and module structure intact.
  const anchor = "(function(exports, require, module, __filename, __dirname) {";
  const at = src.indexOf(anchor);
  if (at === -1) {
    console.error("patch-cli: CJS wrapper anchor not found — bundle format changed; aborting.");
    process.exit(2);
  }
  const insertAt = at + anchor.length;
  const patched = src.slice(0, insertAt) + "\n" + SHIM + "\n" + src.slice(insertAt);
  fs.writeFileSync(CLI, patched);
  console.log(`patch-cli: injected fetch shim into ${CLI} (+${patched.length - src.length} bytes)`);
}

main();

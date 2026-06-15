"use client";

// The chat surface. Drives the Vercel AI Elements components with plain React
// state and a streaming fetch reader — NO Vercel AI SDK / useChat. It POSTs to
// /api/agent (the Bun route handler) and consumes the NDJSON event stream,
// rendering the agent's text, reasoning, and each tool call live.

import { useCallback, useRef, useState } from "react";
import { TerminalIcon } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { Shimmer } from "@/components/ai-elements/shimmer";

type Status = "ready" | "submitted" | "streaming" | "error";

type ToolView = {
  id: string;
  name: string;
  input: unknown;
  output?: string;
  errorText?: string;
  state: "input-available" | "output-available" | "output-error";
};

type Part =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "error"; text: string }
  | { kind: "tool"; tool: ToolView };

type ChatMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; parts: Part[] };

// One NDJSON line from the route handler.
type AgentEvent =
  | { t: "init"; model?: string }
  | { t: "text_delta"; text: string }
  | { t: "reasoning_delta"; text: string }
  | { t: "text"; text: string }
  | { t: "reasoning"; text: string }
  | { t: "tool_use"; id: string; name: string; input: unknown }
  | { t: "tool_result"; id: string; text: string; is_error?: boolean }
  | { t: "result"; ok: boolean; final: string | null }
  | { t: "error"; error: string };

const EXAMPLES = [
  "List everything in /workspace",
  "Write a Python fizzbuzz and run it",
  "Create a 3-item TODO.md, then read it back",
  "What OS and tools do you have here?",
];

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

const toolLabel = (name: string) => name.replace(/^mcp__workspace__/, "");

// Append a streaming delta to the last part if it's the same kind, else start a
// new part — this is what segments text/reasoning around tool calls.
function appendDelta(
  parts: Part[],
  kind: "text" | "reasoning",
  text: string,
): Part[] {
  const last = parts[parts.length - 1];
  if (last && last.kind === kind) {
    return [...parts.slice(0, -1), { kind, text: last.text + text }];
  }
  return [...parts, { kind, text }];
}

export function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<Status>("ready");
  const [model, setModel] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const busy = status === "submitted" || status === "streaming";

  // Mutate the most recent assistant message's parts.
  const patchAssistant = useCallback((fn: (parts: Part[]) => Part[]) => {
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        const m = next[i];
        if (m.role === "assistant") {
          next[i] = { ...m, parts: fn(m.parts) };
          break;
        }
      }
      return next;
    });
  }, []);

  const handleEvent = useCallback(
    (ev: AgentEvent) => {
      switch (ev.t) {
        case "init":
          if (ev.model) setModel(ev.model);
          break;
        case "text_delta":
          patchAssistant((parts) => appendDelta(parts, "text", ev.text));
          break;
        case "reasoning_delta":
          patchAssistant((parts) => appendDelta(parts, "reasoning", ev.text));
          break;
        case "text":
          patchAssistant((parts) => [...parts, { kind: "text", text: ev.text }]);
          break;
        case "reasoning":
          patchAssistant((parts) => [...parts, { kind: "reasoning", text: ev.text }]);
          break;
        case "tool_use":
          patchAssistant((parts) => [
            ...parts,
            {
              kind: "tool",
              tool: {
                id: ev.id,
                name: toolLabel(ev.name),
                input: ev.input,
                state: "input-available",
              },
            },
          ]);
          break;
        case "tool_result":
          patchAssistant((parts) =>
            parts.map((p) =>
              p.kind === "tool" && p.tool.id === ev.id
                ? {
                    ...p,
                    tool: {
                      ...p.tool,
                      output: ev.is_error ? undefined : ev.text,
                      errorText: ev.is_error ? ev.text : undefined,
                      state: ev.is_error ? "output-error" : "output-available",
                    },
                  }
                : p,
            ),
          );
          break;
        case "result":
          // The streamed text already carries every assistant turn, so only fall
          // back to `final` if nothing textual was rendered.
          patchAssistant((parts) =>
            ev.final && !parts.some((p) => p.kind === "text")
              ? [...parts, { kind: "text", text: ev.final }]
              : parts,
          );
          break;
        case "error":
          patchAssistant((parts) => [...parts, { kind: "error", text: ev.error }]);
          setStatus("error");
          break;
      }
    },
    [patchAssistant],
  );

  const run = useCallback(
    async (prompt: string) => {
      setStatus("submitted");
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          let msg = `HTTP ${res.status}`;
          try {
            const j = await res.json();
            msg = j.error || msg;
          } catch {}
          throw new Error(msg);
        }
        setStatus("streaming");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) handleEvent(JSON.parse(line) as AgentEvent);
          }
        }
        const tail = buffer.trim();
        if (tail) handleEvent(JSON.parse(tail) as AgentEvent);
        setStatus((s) => (s === "error" ? s : "ready"));
      } catch (e: unknown) {
        if (ac.signal.aborted) {
          patchAssistant((parts) => [...parts, { kind: "text", text: "_⏹ Stopped._" }]);
          setStatus("ready");
        } else {
          patchAssistant((parts) => [
            ...parts,
            { kind: "error", text: e instanceof Error ? e.message : String(e) },
          ]);
          setStatus("error");
        }
      } finally {
        abortRef.current = null;
      }
    },
    [handleEvent, patchAssistant],
  );

  const submitPrompt = useCallback(
    (text: string) => {
      const prompt = text.trim();
      if (!prompt || busy) return;
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: "user", text: prompt },
        { id: uid(), role: "assistant", parts: [] },
      ]);
      void run(prompt);
    },
    [busy, run],
  );

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => submitPrompt(message.text ?? ""),
    [submitPrompt],
  );

  const handleStop = useCallback(() => abortRef.current?.abort(), []);
  const empty = messages.length === 0;

  return (
    <div className="flex h-full flex-col">
      <Conversation className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-8 sm:px-6">
          {empty ? (
            <EmptyState onPick={submitPrompt} disabled={busy} />
          ) : (
            messages.map((m) => (
              <Message
                className={`animate-rise ${m.role === "assistant" ? "max-w-full" : ""}`}
                from={m.role}
                key={m.id}
              >
                <MessageContent
                  className={m.role === "assistant" ? "w-full gap-3" : ""}
                >
                  {m.role === "user" ? (
                    <span className="font-mono text-[13px] leading-relaxed">
                      {m.text}
                    </span>
                  ) : m.parts.length === 0 && busy ? (
                    <Shimmer>Thinking…</Shimmer>
                  ) : (
                    m.parts.map((p, i) => (
                      <PartView
                        key={i}
                        part={p}
                        streaming={busy && i === m.parts.length - 1}
                      />
                    ))
                  )}
                </MessageContent>
              </Message>
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-border/70 border-t bg-background/60 px-4 py-3.5 backdrop-blur sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <PromptInput onSubmit={handleSubmit}>
            <PromptInputBody>
              <PromptInputTextarea placeholder="Ask the agent to write, run, or inspect files…" />
            </PromptInputBody>
            <PromptInputFooter className="px-1">
              <PromptInputTools>
                <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground uppercase tracking-[0.08em]">
                  <TerminalIcon className="size-3 text-ember" />
                  {model ?? "claude code"}
                </span>
              </PromptInputTools>
              <div className="flex items-center gap-2.5">
                <span className="hidden font-mono text-[10px] text-muted-foreground/60 sm:inline">
                  ⏎ run · ⇧⏎ newline
                </span>
                <PromptInputSubmit onStop={handleStop} status={status} />
              </div>
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  onPick,
  disabled,
}: {
  onPick: (text: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex min-h-[58vh] animate-rise flex-col items-center justify-center gap-7 px-2 text-center">
      <div className="ember-glow flex size-14 items-center justify-center rounded-xl border border-ember/40 bg-ember/10 font-mono text-2xl text-ember">
        <span aria-hidden>&gt;_</span>
      </div>
      <div className="space-y-3">
        <h2 className="font-mono font-semibold text-foreground text-xl tracking-tight">
          serverless Claude Code
        </h2>
        <p className="mx-auto max-w-md text-muted-foreground text-sm leading-relaxed">
          A real coding agent with its own shell and filesystem, running on Vercel
          Bun. Ask it to write, run, and inspect files in an isolated{" "}
          <span className="font-mono text-foreground/80">/workspace</span>.
        </p>
      </div>
      <div className="flex max-w-xl flex-wrap items-center justify-center gap-2">
        {EXAMPLES.map((ex) => (
          <button
            className="rounded-full border border-border/70 bg-card/40 px-3.5 py-1.5 font-mono text-[12px] text-muted-foreground transition-colors hover:border-ember/50 hover:bg-ember/10 hover:text-foreground disabled:opacity-50"
            disabled={disabled}
            key={ex}
            onClick={() => onPick(ex)}
            type="button"
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}

function PartView({
  part,
  streaming = false,
}: {
  part: Part;
  streaming?: boolean;
}) {
  if (part.kind === "text") {
    return <MessageResponse>{part.text}</MessageResponse>;
  }
  if (part.kind === "reasoning") {
    return (
      <Reasoning isStreaming={streaming}>
        <ReasoningTrigger />
        <ReasoningContent>{part.text}</ReasoningContent>
      </Reasoning>
    );
  }
  if (part.kind === "error") {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-destructive text-xs">
        {part.text}
      </div>
    );
  }
  const { tool } = part;
  return (
    <Tool className="mb-0 rounded-lg border-border/70 bg-card/40">
      <ToolHeader
        className="font-mono"
        state={tool.state}
        title={tool.name}
        toolName={tool.name}
        type="dynamic-tool"
      />
      <ToolContent>
        <ToolInput input={tool.input} />
        <ToolOutput errorText={tool.errorText} output={tool.output} />
      </ToolContent>
    </Tool>
  );
}

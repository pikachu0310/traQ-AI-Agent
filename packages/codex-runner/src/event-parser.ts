import type { RunnerProgressEvent } from "@mvp/shared";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function flattenText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => flattenText(item)).filter(Boolean).join("\n");
  }
  const record = asRecord(value);
  if (!record) return "";
  return [
    record.text,
    record.message,
    record.output_text,
    record.stdout,
    record.stderr,
    record.content,
    record.result,
    record.summary,
    record.reasoning,
    record.reasoning_summary,
    record.analysis,
    record.thinking,
    record.output,
    record.value,
  ]
    .map((item) => flattenText(item))
    .filter(Boolean)
    .join("\n");
}

function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isReasoningItem(itemType: string, item: Record<string, unknown>): boolean {
  if (!itemType) return false;
  if (!/reason|think|analysis/i.test(itemType)) return false;
  if (itemType === "agent_message") return false;
  return true;
}

function extractReasoningText(item: Record<string, unknown>): string {
  const text = flattenText([
    item.summary,
    item.reasoning,
    item.reasoning_summary,
    item.analysis,
    item.thinking,
    item.content,
    item.result,
    item.text,
  ]);
  return normalizeInlineText(text);
}

function flattenCommand(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "";
  const direct = [
    record.command,
    record.command_line,
    record.cmd,
    record.input,
  ]
    .map((item) => flattenText(item))
    .filter(Boolean)
    .join(" ");
  return direct.trim();
}

export interface ParsedLineResult {
  sessionId?: string;
  progressEvents: RunnerProgressEvent[];
  latestAgentMessage?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
}

export class CodexEventParser {
  parseLine(rawLine: string): ParsedLineResult {
    const line = rawLine.trim();
    if (!line) {
      return { progressEvents: [] };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { progressEvents: [] };
    }

    const eventType = typeof payload.type === "string" ? payload.type : "";
    const progressEvents: RunnerProgressEvent[] = [];
    let latestAgentMessage: string | undefined;
    let sessionId: string | undefined;
    let usage: ParsedLineResult["usage"];

    if (eventType === "thread.started") {
      const threadId = payload.thread_id;
      if (typeof threadId === "string" && threadId) {
        sessionId = threadId;
        progressEvents.push({ type: "session_started", sessionId: threadId });
      }
      return { sessionId, progressEvents };
    }

    if (eventType === "turn.started") {
      progressEvents.push({ type: "turn_started" });
      return { progressEvents };
    }

    if (eventType === "turn.completed") {
      const usageRecord = asRecord(payload.usage);
      usage = usageRecord
        ? {
            inputTokens:
              typeof usageRecord.input_tokens === "number"
                ? usageRecord.input_tokens
                : undefined,
            outputTokens:
              typeof usageRecord.output_tokens === "number"
                ? usageRecord.output_tokens
                : undefined,
            cachedInputTokens:
              typeof usageRecord.cached_input_tokens === "number"
                ? usageRecord.cached_input_tokens
                : undefined,
          }
        : undefined;
      progressEvents.push({ type: "run_completed", usage });
      return { progressEvents, usage };
    }

    const item = asRecord(payload.item);
    if (!item) {
      if (eventType === "error") {
        const message = flattenText(payload.error) || flattenText(payload);
        if (message) progressEvents.push({ type: "error", message });
      }
      return { progressEvents };
    }

    const itemType = typeof item.type === "string" ? item.type : "";

    if (eventType === "item.started" && itemType === "mcp_tool_call") {
      const server = typeof item.server === "string" ? item.server : "unknown";
      const tool = typeof item.tool === "string" ? item.tool : "unknown";
      progressEvents.push({
        type: "tool_call_started",
        server,
        tool,
        arguments: item.arguments,
      });
      return { progressEvents };
    }

    if (eventType === "item.completed" && itemType === "mcp_tool_call") {
      const server = typeof item.server === "string" ? item.server : "unknown";
      const tool = typeof item.tool === "string" ? item.tool : "unknown";
      const status = item.status === "failed" ? "failed" : "completed";
      const detail =
        flattenText(item.error) || flattenText(item.result) || undefined;
      progressEvents.push({
        type: "tool_call_finished",
        server,
        tool,
        status,
        detail,
      });
      return { progressEvents };
    }

    if (itemType === "command_execution" || itemType === "shell_command") {
      const command = flattenCommand(item);
      if (eventType === "item.started" && command) {
        progressEvents.push({ type: "command_started", command });
      }
      if (eventType === "item.completed" && command) {
        const exitCode =
          typeof item.exit_code === "number"
            ? item.exit_code
            : typeof item.exitCode === "number"
              ? item.exitCode
              : undefined;
        progressEvents.push({ type: "command_finished", command, exitCode });
      }
      return { progressEvents };
    }

    if (eventType.startsWith("item.") && isReasoningItem(itemType, item)) {
      const text = extractReasoningText(item);
      if (text) {
        progressEvents.push({ type: "agent_reasoning", text });
      }
      return { progressEvents };
    }

    if (eventType === "item.completed" && itemType === "agent_message") {
      const text = flattenText(item.text) || flattenText(item);
      if (text) {
        latestAgentMessage = text;
        progressEvents.push({ type: "agent_message", text });
      }
      return { progressEvents, latestAgentMessage };
    }

    return { progressEvents };
  }
}

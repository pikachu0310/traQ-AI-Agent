import type { CodexRunResult, ConversationRecord, InboundTraqMessage } from "@mvp/shared";
import type { RunnerProgressEvent } from "@mvp/shared";
import { CodexRunner } from "@mvp/codex-runner";
import type { BotAdapter } from "./adapters/types.js";

function truncate(text: string, max = 240): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeInline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseMcpArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function isSensitiveKey(key: string): boolean {
  return /token|password|secret|api_?key|authorization|cookie/i.test(key);
}

function formatArgumentValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return `"${normalizeInline(truncate(value, 80))}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const preview = value.slice(0, 3).map((entry) => formatArgumentValue(entry)).join(", ");
    const suffix = value.length > 3 ? ", ..." : "";
    return `[${preview}${suffix}]`;
  }
  const record = asRecord(value);
  if (!record) return `"${truncate(String(value), 80)}"`;

  const prioritizedKeys = ["word", "query", "q", "text", "id", "name", "channelId", "threadId"];
  for (const key of prioritizedKeys) {
    const candidate = record[key];
    if (candidate !== undefined) {
      return `{${key}: ${formatArgumentValue(candidate)}}`;
    }
  }
  return "{...}";
}

function summarizeMcpArguments(tool: string, argumentsValue: unknown): string | undefined {
  if (argumentsValue === undefined) return undefined;

  const parsed = parseMcpArguments(argumentsValue);
  if (typeof parsed === "string") {
    const normalized = normalizeInline(parsed);
    return normalized ? `入力: "${truncate(normalized, 140)}"` : undefined;
  }
  if (parsed === null || typeof parsed === "number" || typeof parsed === "boolean") {
    return `入力: ${String(parsed)}`;
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return "入力: []";
    return `入力: ${truncate(formatArgumentValue(parsed), 160)}`;
  }

  const record = asRecord(parsed);
  if (!record) return undefined;

  const prioritizedKeys = [
    "word",
    "query",
    "q",
    "keyword",
    "text",
    "message",
    "channelId",
    "threadId",
    "userId",
    "limit",
    "offset",
    "id",
  ];

  const entries = Object.entries(record)
    .filter(([key, value]) => !isSensitiveKey(key) && value !== undefined && value !== "")
    .sort(([left], [right]) => {
      const leftIndex = prioritizedKeys.indexOf(left);
      const rightIndex = prioritizedKeys.indexOf(right);
      if (leftIndex !== -1 || rightIndex !== -1) {
        if (leftIndex === -1) return 1;
        if (rightIndex === -1) return -1;
        if (leftIndex !== rightIndex) return leftIndex - rightIndex;
      }
      return left.localeCompare(right);
    })
    .slice(0, 4)
    .map(([key, value]) => `${key}=${formatArgumentValue(value)}`);

  if (entries.length === 0) return undefined;
  const label = /search|find|query|lookup/i.test(tool) ? "検索条件" : "入力";
  return `${label}: ${truncate(entries.join(", "), 180)}`;
}

interface BotServiceOptions {
  globalAgentsInstructions?: string;
  globalAgentsSourcePath?: string;
  maxAgentMessages?: number;
  maxReasoningMessages?: number;
}

type InboundCommand =
  | { type: "run_codex"; prompt: string }
  | { type: "reset_session" }
  | { type: "ignore" };

export class BotService {
  private readonly globalAgentsInstructions?: string;
  private readonly globalAgentsSourcePath?: string;
  private readonly maxAgentMessages: number;
  private readonly maxReasoningMessages: number;

  constructor(
    private readonly triggerPrefix: string,
    private readonly adapter: BotAdapter,
    private readonly runner: CodexRunner,
    options: BotServiceOptions = {},
  ) {
    this.globalAgentsInstructions = options.globalAgentsInstructions?.trim() || undefined;
    this.globalAgentsSourcePath = options.globalAgentsSourcePath;
    this.maxAgentMessages = options.maxAgentMessages ?? 4;
    this.maxReasoningMessages = options.maxReasoningMessages ?? 8;
  }

  async start(): Promise<void> {
    await this.adapter.start(async (message) => {
      await this.handleMessage(message);
    });
  }

  private extractCommand(text: string): InboundCommand {
    const normalized = text.trim();
    if (normalized === "/reset") {
      return { type: "reset_session" };
    }
    if (!normalized.startsWith(this.triggerPrefix)) {
      return { type: "ignore" };
    }
    const prompt = normalized.slice(this.triggerPrefix.length).trim();
    return {
      type: "run_codex",
      prompt: prompt.length > 0 ? prompt : "現在の状態を要約してください。",
    };
  }

  private async handleMessage(message: InboundTraqMessage): Promise<void> {
    const command = this.extractCommand(message.text);
    if (command.type === "ignore") return;
    const conversationKey = message.threadId ?? message.channelId;
    const target = { channelId: message.channelId, threadId: message.threadId };
    const store = this.runner.getStore();

    if (command.type === "reset_session") {
      const deleted = await store.deleteConversation(conversationKey);
      await this.adapter.sendMessage(
        target,
        deleted
          ? "このチャンネルのセッションをリセットしました。次回の `/codex` は新しいセッションで実行します。"
          : "このチャンネルに保持中のセッションはありません。次回の `/codex` は新しいセッションで実行します。",
      );
      return;
    }

    const prompt = command.prompt;
    const codexPrompt = this.buildExecutionPrompt(prompt);
    const previous = await store.loadConversation(conversationKey);

    let agentMessageProgressCount = 0;
    let reasoningProgressCount = 0;
    let lastReasoningMessage = "";
    let startProgressNotified = false;
    let latestRunUsage:
      | {
          inputTokens?: number;
          outputTokens?: number;
          cachedInputTokens?: number;
        }
      | undefined;
    try {
      const result = await this.runner.run(
        {
          conversationKey,
          prompt: codexPrompt,
          resumeSessionId: previous?.lastSessionId,
        },
        async (event) => {
          if (event.type === "session_started") {
            startProgressNotified = true;
            await this.adapter.sendMessage(
              target,
              `Codex 実行を開始 (conversationKey=\`${conversationKey}\`) (セッション開始: \`${event.sessionId}\`)`,
            );
            return;
          }
          if (event.type === "run_completed") {
            latestRunUsage = event.usage;
          }
          if (event.type === "agent_reasoning") {
            const normalized = normalizeInline(event.text);
            if (!normalized || normalized === lastReasoningMessage) {
              return;
            }
            lastReasoningMessage = normalized;
          }

          const progressText = this.formatProgressEvent(
            event,
            () => {
              agentMessageProgressCount += 1;
              return agentMessageProgressCount;
            },
            () => {
              reasoningProgressCount += 1;
              return reasoningProgressCount;
            },
          );
          if (!progressText) return;
          await this.adapter.sendMessage(target, progressText);
        },
      );

      if (!startProgressNotified) {
        await this.adapter.sendMessage(
          target,
          `Codex 実行を開始 (conversationKey=\`${conversationKey}\`)`,
        );
      }

      await this.saveConversation(previous, conversationKey, prompt, result);
      await this.adapter.sendMessage(
        target,
        [
          "最終回答:",
          result.finalAnswer,
          "",
          `(input=${latestRunUsage?.inputTokens ?? "?"}, output=${latestRunUsage?.outputTokens ?? "?"})`,
        ].join("\n"),
      );
    } catch (error) {
      await this.adapter.sendMessage(
        target,
        `実行中にエラーが発生しました: ${truncate(String(error))}`,
      );
    }
  }

  private buildExecutionPrompt(userPrompt: string): string {
    const lines = [
      "You are the execution agent for a traQ bot MVP.",
      "When the user asks about traQ data or operations, use MCP tools prefixed with `traq_` first.",
      "Do not use `list_mcp_resources` / `list_mcp_resource_templates` as the primary availability check for traQ operations.",
      "Start traQ exploration with `traq_get_api_capabilities`, then continue with other `traq_` tools.",
      "Use local fixture tools (`get_demo_service_status`, `read_fixture_markdown`) only when local fixture context is needed.",
      "Prefer MCP tools over ad-hoc shell commands whenever equivalent tools exist.",
    ];

    if (this.globalAgentsInstructions) {
      const sourceLabel = this.globalAgentsSourcePath
        ? `Additional operating instructions loaded from ${this.globalAgentsSourcePath}:`
        : "Additional operating instructions loaded from ~/.codex/AGENTS.md:";
      lines.push("", sourceLabel, this.globalAgentsInstructions);
    }

    lines.push("", "User request:", userPrompt);
    return lines.join("\n");
  }

  private formatProgressEvent(
    event: RunnerProgressEvent,
    incrementAgentCounter: () => number,
    incrementReasoningCounter: () => number,
  ): string | null {
    switch (event.type) {
      case "session_started":
        return null;
      case "turn_started":
        return null;
      case "tool_call_started": {
        const detail = summarizeMcpArguments(event.tool, event.arguments);
        if (!detail) return `MCP 呼び出し: \`${event.server}/${event.tool}\``;
        return `MCP 呼び出し: \`${event.server}/${event.tool}\` (${detail})`;
      }
      case "tool_call_finished":
        return null;
      case "command_started":
        return `コマンド実行: \`${truncate(event.command, 120)}\``;
      case "command_finished":
        if (event.exitCode === 0) return null;
        return `コマンド失敗:${
          event.exitCode !== undefined ? ` (exit=${event.exitCode})` : ""
        }`;
      case "agent_reasoning":
        if (incrementReasoningCounter() > this.maxReasoningMessages) return null;
        return `思考: ${truncate(event.text, 320)}`;
      case "agent_message":
        if (incrementAgentCounter() > this.maxAgentMessages) return null;
        return `途中回答: ${truncate(event.text)}`;
      case "error":
        return `進捗エラー: ${truncate(event.message)}`;
      case "run_completed":
        return null;
      default:
        return null;
    }
  }

  private async saveConversation(
    previous: ConversationRecord | null,
    conversationKey: string,
    prompt: string,
    result: CodexRunResult,
  ): Promise<void> {
    const store = this.runner.getStore();
    const record: ConversationRecord = {
      conversationKey,
      updatedAt: new Date().toISOString(),
      lastSessionId: result.sessionId,
      lastPrompt: prompt,
      lastRawLogPath: result.rawLogPath,
      runs: [
        ...(previous?.runs ?? []).slice(-19),
        {
          startedAt: result.startedAt,
          completedAt: result.completedAt,
          prompt,
          sessionId: result.sessionId,
          rawLogPath: result.rawLogPath,
        },
      ],
    };
    await store.saveConversation(record);
  }
}

import type { CodexRunResult, ConversationRecord, InboundTraqMessage } from "@mvp/shared";
import type { RunnerProgressEvent } from "@mvp/shared";
import { CodexRunner } from "@mvp/codex-runner";
import type { BotAdapter } from "./adapters/types.js";

function truncate(text: string, max = 240): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

type InboundCommand =
  | { type: "run_codex"; prompt: string }
  | { type: "reset_session" }
  | { type: "ignore" };

export class BotService {
  constructor(
    private readonly triggerPrefix: string,
    private readonly adapter: BotAdapter,
    private readonly runner: CodexRunner,
  ) {}

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

          const progressText = this.formatProgressEvent(event, () => {
            agentMessageProgressCount += 1;
            return agentMessageProgressCount;
          });
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
    return [
      "You are the execution agent for a traQ bot MVP.",
      "When the user asks about traQ data or operations, use MCP tools prefixed with `traq_` first.",
      "Do not use `list_mcp_resources` / `list_mcp_resource_templates` as the primary availability check for traQ operations.",
      "Start traQ exploration with `traq_get_api_capabilities`, then continue with other `traq_` tools.",
      "Use local fixture tools (`get_demo_service_status`, `read_fixture_markdown`) only when local fixture context is needed.",
      "Prefer MCP tools over ad-hoc shell commands whenever equivalent tools exist.",
      "",
      "User request:",
      userPrompt,
    ].join("\n");
  }

  private formatProgressEvent(
    event: RunnerProgressEvent,
    incrementAgentCounter: () => number,
  ): string | null {
    switch (event.type) {
      case "session_started":
        return null;
      case "turn_started":
        return null;
      case "tool_call_started":
        return `MCP 呼び出し: \`${event.server}/${event.tool}\``;
      case "tool_call_finished":
        return null;
      case "command_started":
        return `コマンド実行: \`${truncate(event.command, 120)}\``;
      case "command_finished":
        if (event.exitCode === 0) return null;
        return `コマンド失敗:${
          event.exitCode !== undefined ? ` (exit=${event.exitCode})` : ""
        }`;
      case "agent_message":
        if (incrementAgentCounter() > 2) return null;
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

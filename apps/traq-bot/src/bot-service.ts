import type { CodexRunResult, ConversationRecord, InboundTraqMessage } from "@mvp/shared";
import type { RunnerProgressEvent } from "@mvp/shared";
import { CodexRunner } from "@mvp/codex-runner";
import type { BotAdapter } from "./adapters/types.js";

function truncate(text: string, max = 240): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

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

  private extractPrompt(text: string): string | null {
    const normalized = text.trim();
    if (!normalized.startsWith(this.triggerPrefix)) return null;
    const prompt = normalized.slice(this.triggerPrefix.length).trim();
    return prompt.length > 0 ? prompt : "現在の状態を要約してください。";
  }

  private async handleMessage(message: InboundTraqMessage): Promise<void> {
    const prompt = this.extractPrompt(message.text);
    if (!prompt) return;
    const codexPrompt = this.buildExecutionPrompt(prompt);

    const conversationKey = message.threadId ?? message.channelId;
    const store = this.runner.getStore();
    const previous = await store.loadConversation(conversationKey);
    const target = { channelId: message.channelId, threadId: message.threadId };

    let agentMessageProgressCount = 0;
    let startProgressNotified = false;
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
          `session_id: ${result.sessionId ?? "(取得できず)"}`,
          `raw_log: ${result.rawLogPath}`,
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
        return `MCP 呼び出し開始: \`${event.server}/${event.tool}\``;
      case "tool_call_finished":
        return `MCP 呼び出し完了: \`${event.server}/${event.tool}\` (${event.status})${
          event.detail ? `\n${truncate(event.detail)}` : ""
        }`;
      case "command_started":
        return `コマンド実行: \`${truncate(event.command, 120)}\``;
      case "command_finished":
        if (event.exitCode === 0) return null;
        return `コマンド完了: \`${truncate(event.command, 120)}\`${
          event.exitCode !== undefined ? ` (exit=${event.exitCode})` : ""
        }`;
      case "agent_message":
        if (incrementAgentCounter() > 2) return null;
        return `途中回答: ${truncate(event.text)}`;
      case "error":
        return `進捗エラー: ${truncate(event.message)}`;
      case "run_completed":
        return `turn 完了: input=${event.usage?.inputTokens ?? "?"}, output=${event.usage?.outputTokens ?? "?"}`;
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

import { describe, expect, it, vi } from "vitest";
import type { ConversationRecord, InboundTraqMessage, OutboundTarget } from "@mvp/shared";
import type { CodexRunner } from "@mvp/codex-runner";
import { BotService } from "../apps/traq-bot/src/bot-service.js";

class TestAdapter {
  public readonly sent: Array<{ target: OutboundTarget; content: string }> = [];

  constructor(private readonly inboundMessages: InboundTraqMessage[]) {}

  async start(
    onMessage: (message: InboundTraqMessage) => Promise<void>,
  ): Promise<void> {
    for (const message of this.inboundMessages) {
      await onMessage(message);
    }
  }

  async sendMessage(target: OutboundTarget, content: string): Promise<void> {
    this.sent.push({ target, content });
  }
}

function makeInboundMessage(
  text: string,
  overrides: Partial<InboundTraqMessage> = {},
): InboundTraqMessage {
  return {
    messageId: "m-1",
    channelId: "channel-a",
    threadId: undefined,
    userId: "user-a",
    text,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("BotService /reset command", () => {
  it("resets channel session and does not run Codex", async () => {
    const store = {
      loadConversation: vi.fn(),
      saveConversation: vi.fn(),
      deleteConversation: vi.fn(async () => true),
    };
    const run = vi.fn();
    const runner = {
      getStore: () => store,
      run,
    } as unknown as CodexRunner;
    const adapter = new TestAdapter([makeInboundMessage("/reset")]);
    const service = new BotService("/codex", adapter, runner);

    await service.start();

    expect(store.deleteConversation).toHaveBeenCalledWith("channel-a");
    expect(run).not.toHaveBeenCalled();
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.content).toContain("セッションをリセット");
  });

  it("uses thread id as conversation key when resetting", async () => {
    const store = {
      loadConversation: vi.fn(),
      saveConversation: vi.fn(),
      deleteConversation: vi.fn(async () => false),
    };
    const runner = {
      getStore: () => store,
      run: vi.fn(),
    } as unknown as CodexRunner;
    const adapter = new TestAdapter([
      makeInboundMessage("/reset", { threadId: "thread-a" }),
    ]);
    const service = new BotService("/codex", adapter, runner);

    await service.start();

    expect(store.deleteConversation).toHaveBeenCalledWith("thread-a");
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.content).toContain("保持中のセッションはありません");
  });

  it("starts a new session after reset in the same conversation", async () => {
    const existing: ConversationRecord = {
      conversationKey: "channel-a",
      updatedAt: new Date().toISOString(),
      lastSessionId: "old-session",
      lastPrompt: "before",
      lastRawLogPath: "codex-sessions/channel-a/old.jsonl",
      runs: [],
    };
    const records = new Map<string, ConversationRecord>([["channel-a", existing]]);
    const store = {
      loadConversation: vi.fn(async (conversationKey: string) => {
        return records.get(conversationKey) ?? null;
      }),
      saveConversation: vi.fn(async (record: ConversationRecord) => {
        records.set(record.conversationKey, record);
      }),
      deleteConversation: vi.fn(async (conversationKey: string) => {
        return records.delete(conversationKey);
      }),
    };
    const run = vi.fn(async () => ({
      sessionId: "new-session",
      finalAnswer: "done",
      rawLogPath: "codex-sessions/channel-a/new.jsonl",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    }));
    const runner = {
      getStore: () => store,
      run,
    } as unknown as CodexRunner;
    const adapter = new TestAdapter([
      makeInboundMessage("/reset"),
      makeInboundMessage("/codex hello"),
    ]);
    const service = new BotService("/codex", adapter, runner);

    await service.start();

    expect(run).toHaveBeenCalledTimes(1);
    const firstRunRequest = run.mock.calls[0]?.[0] as
      | { resumeSessionId?: string }
      | undefined;
    expect(firstRunRequest?.resumeSessionId).toBeUndefined();
  });
});

describe("BotService progress output", () => {
  it("sends a single MCP call log and embeds usage in the final answer", async () => {
    const store = {
      loadConversation: vi.fn(async () => null),
      saveConversation: vi.fn(),
      deleteConversation: vi.fn(),
    };
    const run = vi.fn(async (_request, onProgress) => {
      await onProgress({ type: "session_started", sessionId: "session-1" });
      await onProgress({
        type: "tool_call_started",
        server: "codex_apps",
        tool: "github_get_user_login",
      });
      await onProgress({
        type: "tool_call_finished",
        server: "codex_apps",
        tool: "github_get_user_login",
        status: "completed",
      });
      await onProgress({
        type: "run_completed",
        usage: { inputTokens: 1201384, outputTokens: 9264 },
      });
      return {
        sessionId: "session-1",
        finalAnswer: "回答本文",
        rawLogPath: "codex-sessions/channel-a/demo.jsonl",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
      };
    });
    const runner = {
      getStore: () => store,
      run,
    } as unknown as CodexRunner;
    const adapter = new TestAdapter([makeInboundMessage("/codex hello")]);
    const service = new BotService("/codex", adapter, runner);

    await service.start();

    expect(adapter.sent).toHaveLength(3);
    expect(adapter.sent[1]?.content).toBe(
      "MCP 呼び出し: `codex_apps/github_get_user_login`",
    );
    const finalMessage = adapter.sent[2]?.content ?? "";
    expect(finalMessage).toContain("最終回答:");
    expect(finalMessage).toContain("回答本文");
    expect(finalMessage).toContain("(input=1201384, output=9264)");
    expect(finalMessage).not.toContain("turn 完了:");
    expect(finalMessage).not.toContain("session_id:");
    expect(finalMessage).not.toContain("raw_log:");
  });

  it("sends command failure progress with exit code", async () => {
    const store = {
      loadConversation: vi.fn(async () => null),
      saveConversation: vi.fn(),
      deleteConversation: vi.fn(),
    };
    const run = vi.fn(async (_request, onProgress) => {
      await onProgress({ type: "session_started", sessionId: "session-1" });
      await onProgress({
        type: "command_finished",
        command: "false",
        exitCode: 1,
      });
      await onProgress({
        type: "run_completed",
        usage: { inputTokens: 123, outputTokens: 45 },
      });
      return {
        sessionId: "session-1",
        finalAnswer: "回答本文",
        rawLogPath: "codex-sessions/channel-a/demo.jsonl",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
      };
    });
    const runner = {
      getStore: () => store,
      run,
    } as unknown as CodexRunner;
    const adapter = new TestAdapter([makeInboundMessage("/codex hello")]);
    const service = new BotService("/codex", adapter, runner);

    await service.start();

    expect(adapter.sent).toHaveLength(3);
    expect(adapter.sent[1]?.content).toBe("コマンド失敗: (exit=1)");
  });
});

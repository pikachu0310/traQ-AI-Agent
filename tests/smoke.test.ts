import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CodexEventParser } from "../packages/codex-runner/src/event-parser.js";
import { FileStateStore } from "../packages/shared/src/persistence/file-store.js";

describe("CodexEventParser", () => {
  it("extracts session id and mcp tool progress events", () => {
    const parser = new CodexEventParser();

    const started = parser.parseLine(
      JSON.stringify({
        type: "thread.started",
        thread_id: "session-123",
      }),
    );
    expect(started.sessionId).toBe("session-123");
    expect(started.progressEvents[0]).toEqual({
      type: "session_started",
      sessionId: "session-123",
    });

    const toolStarted = parser.parseLine(
      JSON.stringify({
        type: "item.started",
        item: {
          type: "mcp_tool_call",
          server: "mastra_local",
          tool: "get_demo_service_status",
        },
      }),
    );
    expect(toolStarted.progressEvents[0]).toMatchObject({
      type: "tool_call_started",
      server: "mastra_local",
      tool: "get_demo_service_status",
    });
  });
});

describe("FileStateStore", () => {
  it("persists conversation mapping", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mvp-store-"));
    const store = new FileStateStore(tempDir);
    await store.initialize();

    await store.saveConversation({
      conversationKey: "thread-a",
      updatedAt: new Date().toISOString(),
      lastSessionId: "session-a",
      lastPrompt: "hello",
      lastRawLogPath: "codex-sessions/thread-a/demo.jsonl",
      runs: [],
    });

    const loaded = await store.loadConversation("thread-a");
    expect(loaded?.lastSessionId).toBe("session-a");

    await rm(tempDir, { recursive: true, force: true });
  });
});

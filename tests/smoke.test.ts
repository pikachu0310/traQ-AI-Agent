import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CodexEventParser } from "../packages/codex-runner/src/event-parser.js";
import { FileStateStore } from "../packages/shared/src/persistence/file-store.js";
import { loadAppConfig } from "../packages/shared/src/config.js";

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

    const reasoning = parser.parseLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "reasoning",
          summary: [{ text: "まず必要な API を確認する" }],
        },
      }),
    );
    expect(reasoning.progressEvents[0]).toEqual({
      type: "agent_reasoning",
      text: "まず必要な API を確認する",
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

  it("deletes only specified conversation mapping", async () => {
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
    await store.saveConversation({
      conversationKey: "thread-b",
      updatedAt: new Date().toISOString(),
      lastSessionId: "session-b",
      lastPrompt: "world",
      lastRawLogPath: "codex-sessions/thread-b/demo.jsonl",
      runs: [],
    });

    const deleted = await store.deleteConversation("thread-a");
    expect(deleted).toBe(true);
    expect(await store.loadConversation("thread-a")).toBeNull();
    expect((await store.loadConversation("thread-b"))?.lastSessionId).toBe(
      "session-b",
    );

    const missingDeleted = await store.deleteConversation("thread-a");
    expect(missingDeleted).toBe(false);

    await rm(tempDir, { recursive: true, force: true });
  });
});

describe("loadAppConfig", () => {
  it("resolves paths from workspace root when started in a subpackage cwd", () => {
    const fakeEnv = {
      BOT_MODE: "real",
      TRAQ_BOT_TOKEN: "dummy-token",
      BOT_DATA_DIR: "./data",
      CODEX_WORKING_DIR: ".",
      CODEX_HOME_TEMPLATE_DIR: "./data/runtime/codex-home",
      CODEX_AUTH_SOURCE: "~/.codex/auth.json",
      MCP_SERVER_CWD: ".",
      TRAQ_API_BASE_URL: "https://example.invalid/api/v3",
      TRAQ_MCP_ENABLE_WRITE_TOOLS: "true",
      TRAQ_MCP_DEFAULT_LIMIT: "50",
      INIT_CWD: "/tmp/unrelated-repo",
    } as unknown as NodeJS.ProcessEnv;

    const packageCwd = path.resolve("apps/traq-bot");
    const config = loadAppConfig(fakeEnv, packageCwd);

    expect(config.mode).toBe("real");
    expect(config.traq.token).toBe("dummy-token");
    expect(config.dataDir).toBe(path.resolve("data"));
    expect(config.codexWorkingDir).toBe(path.resolve("."));
    expect(config.codex.codexHomeTemplateDir).toBe(
      path.resolve("data/runtime/codex-home"),
    );
    expect(config.codex.model).toBe("gpt-5.3-codex");
    expect(config.codex.reasoningEffort).toBe("high");
    expect(config.codex.agentsPath).toBe(
      path.resolve(path.join(os.homedir(), ".codex/AGENTS.md")),
    );
    expect(config.mcp.cwd).toBe(path.resolve("."));
    expect(config.mcp.env).toEqual({
      TRAQ_API_BASE_URL: "https://example.invalid/api/v3",
      TRAQ_BOT_TOKEN: "dummy-token",
      TRAQ_MCP_DEFAULT_LIMIT: "50",
      TRAQ_MCP_ENABLE_WRITE_TOOLS: "true",
    });
  });
});

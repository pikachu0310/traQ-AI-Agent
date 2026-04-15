import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { prepareCodexHome } from "../packages/codex-runner/src/codex-config.js";

describe("prepareCodexHome", () => {
  it("writes mcp env values into config.toml", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mvp-codex-home-"));
    await prepareCodexHome({
      codexHomeDir: tempDir,
      workspaceDir: "/workspace/repo",
      mcpCommand: "node",
      mcpArgs: ["--import", "tsx", "apps/mastra-mcp/src/index.ts"],
      mcpCwd: "/workspace/repo",
      mcpEnv: {
        TRAQ_MCP_ENABLE_WRITE_TOOLS: "true",
        TRAQ_API_BASE_URL: "https://q.trap.jp/api/v3",
        TRAQ_BOT_TOKEN: 'token-"demo"',
      },
    });

    const configToml = await readFile(path.join(tempDir, "config.toml"), "utf-8");
    expect(configToml).toContain("[mcp_servers.mastra_local.env]");
    expect(configToml).toContain('TRAQ_API_BASE_URL = "https://q.trap.jp/api/v3"');
    expect(configToml).toContain('TRAQ_BOT_TOKEN = "token-\\"demo\\""');
    expect(configToml).toContain('TRAQ_MCP_ENABLE_WRITE_TOOLS = "true"');

    const apiIdx = configToml.indexOf("TRAQ_API_BASE_URL");
    const tokenIdx = configToml.indexOf("TRAQ_BOT_TOKEN");
    const writeIdx = configToml.indexOf("TRAQ_MCP_ENABLE_WRITE_TOOLS");
    expect(apiIdx).toBeGreaterThan(-1);
    expect(tokenIdx).toBeGreaterThan(apiIdx);
    expect(writeIdx).toBeGreaterThan(tokenIdx);

    await rm(tempDir, { recursive: true, force: true });
  });

  it("omits mcp env table when no forwarded env exists", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mvp-codex-home-"));
    await prepareCodexHome({
      codexHomeDir: tempDir,
      workspaceDir: "/workspace/repo",
      mcpCommand: "node",
      mcpArgs: ["apps/mastra-mcp/src/index.ts"],
      mcpCwd: "/workspace/repo",
      mcpEnv: {},
    });

    const configToml = await readFile(path.join(tempDir, "config.toml"), "utf-8");
    expect(configToml).not.toContain("[mcp_servers.mastra_local.env]");

    await rm(tempDir, { recursive: true, force: true });
  });
});

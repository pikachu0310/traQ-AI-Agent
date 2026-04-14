import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../packages/shared/src/config.js";

describe("loadAppConfig", () => {
  it("parses CODEX_ENABLE_FEATURES with comma/space separators", () => {
    const config = loadAppConfig(
      {
        CODEX_ENABLE_FEATURES: "rmcp_client, foo   bar rmcp_client",
      },
      "/tmp/project",
    );

    expect(config.codex.enableFeatures).toEqual(["rmcp_client", "foo", "bar"]);
  });

  it("uses empty feature list by default", () => {
    const config = loadAppConfig({}, path.resolve("/tmp/project"));
    expect(config.codex.enableFeatures).toEqual([]);
  });

  it("uses legacy single MCP server config by default", () => {
    const config = loadAppConfig({}, "/tmp/project");
    expect(config.mcp.servers).toEqual([
      {
        name: "mastra_local",
        command: "node",
        args: ["--import", "tsx", "apps/mastra-mcp/src/index.ts"],
        cwd: "/tmp/project",
      },
    ]);
  });

  it("adds traq_api MCP server when TRAQ_BOT_TOKEN exists", () => {
    const config = loadAppConfig(
      {
        TRAQ_BOT_TOKEN: "token",
      },
      "/tmp/project",
    );
    expect(config.mcp.servers.map((server) => server.name)).toEqual([
      "mastra_local",
      "traq_api",
    ]);
  });

  it("accepts MCP_SERVERS_JSON override", () => {
    const config = loadAppConfig(
      {
        MCP_SERVERS_JSON: JSON.stringify([
          {
            name: "mastra_local",
            command: "node",
            args: ["--import", "tsx", "apps/mastra-mcp/src/index.ts"],
            cwd: ".",
          },
          {
            name: "traq_api",
            command: "node",
            args: ["--import", "tsx", "apps/traq-mcp/src/index.ts"],
            cwd: "./apps/traq-mcp",
          },
        ]),
      },
      "/tmp/project",
    );
    expect(config.mcp.servers).toEqual([
      {
        name: "mastra_local",
        command: "node",
        args: ["--import", "tsx", "apps/mastra-mcp/src/index.ts"],
        cwd: "/tmp/project",
      },
      {
        name: "traq_api",
        command: "node",
        args: ["--import", "tsx", "apps/traq-mcp/src/index.ts"],
        cwd: "/tmp/project/apps/traq-mcp",
      },
    ]);
  });
});

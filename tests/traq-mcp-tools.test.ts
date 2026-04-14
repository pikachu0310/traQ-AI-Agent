import { describe, expect, it } from "vitest";
import {
  buildChannelPathMap,
  buildTraqTools,
  parseTraqMcpConfig,
} from "../apps/mastra-mcp/src/providers/traq-tools.js";

describe("parseTraqMcpConfig", () => {
  it("returns safe defaults", () => {
    const config = parseTraqMcpConfig({} as NodeJS.ProcessEnv);
    expect(config.token).toBeUndefined();
    expect(config.apiBaseUrl).toBe("https://q.trap.jp/api/v3");
    expect(config.enableWriteTools).toBe(false);
    expect(config.defaultLimit).toBe(30);
  });

  it("parses env values and clamps default limit", () => {
    const config = parseTraqMcpConfig({
      TRAQ_BOT_TOKEN: "test-token",
      TRAQ_API_BASE_URL: "https://example.invalid/api/v3",
      TRAQ_MCP_ENABLE_WRITE_TOOLS: "true",
      TRAQ_MCP_DEFAULT_LIMIT: "999",
    } as NodeJS.ProcessEnv);

    expect(config.token).toBe("test-token");
    expect(config.apiBaseUrl).toBe("https://example.invalid/api/v3");
    expect(config.enableWriteTools).toBe(true);
    expect(config.defaultLimit).toBe(100);
  });
});

describe("buildChannelPathMap", () => {
  it("builds path strings from parent links", () => {
    const map = buildChannelPathMap([
      {
        id: "root",
        parentId: null,
        archived: false,
        force: false,
        topic: "",
        name: "general",
        children: ["child"],
      },
      {
        id: "child",
        parentId: "root",
        archived: false,
        force: false,
        topic: "",
        name: "dev",
        children: ["grandchild"],
      },
      {
        id: "grandchild",
        parentId: "child",
        archived: false,
        force: false,
        topic: "",
        name: "frontend",
        children: [],
      },
    ]);

    expect(map.get("root")).toBe("#general");
    expect(map.get("child")).toBe("#general/dev");
    expect(map.get("grandchild")).toBe("#general/dev/frontend");
  });

  it("handles cyclic parent references without recursion explosion", () => {
    const map = buildChannelPathMap([
      {
        id: "loop",
        parentId: "loop",
        archived: false,
        force: false,
        topic: "",
        name: "loop",
        children: [],
      },
    ]);

    expect(map.get("loop")).toBe("#loop/loop");
  });
});

describe("buildTraqTools", () => {
  it("exposes write tools only when explicitly enabled", () => {
    const readOnly = buildTraqTools({
      TRAQ_MCP_ENABLE_WRITE_TOOLS: "false",
    } as NodeJS.ProcessEnv);
    expect(Object.keys(readOnly.tools)).not.toContain("traq_post_message");
    expect(Object.keys(readOnly.tools)).not.toContain("traq_post_direct_message");

    const writeEnabled = buildTraqTools({
      TRAQ_MCP_ENABLE_WRITE_TOOLS: "true",
    } as NodeJS.ProcessEnv);
    expect(Object.keys(writeEnabled.tools)).toContain("traq_post_message");
    expect(Object.keys(writeEnabled.tools)).toContain("traq_post_direct_message");
  });
});

import { describe, expect, it } from "vitest";
import { buildCatalogResources } from "../apps/mastra-mcp/src/providers/catalog-resources.js";
import { buildFixtureTools } from "../apps/mastra-mcp/src/providers/fixture-tools.js";
import { buildTraqTools } from "../apps/mastra-mcp/src/providers/traq-tools.js";

describe("buildCatalogResources", () => {
  const bundles = [
    buildFixtureTools(),
    buildTraqTools({ TRAQ_MCP_ENABLE_WRITE_TOOLS: "false" } as NodeJS.ProcessEnv),
  ];
  const resources = buildCatalogResources(bundles);

  it("lists overview and tool catalog resources", async () => {
    const listed = await resources.listResources({ extra: {} as never });
    const uris = listed.map((resource) => resource.uri);

    expect(uris).toContain("mastra://catalog/overview");
    expect(uris).toContain("mastra://catalog/tools");
  });

  it("returns tool catalog content that includes traq tools", async () => {
    const content = await resources.getResourceContent({
      uri: "mastra://catalog/tools",
      extra: {} as never,
    });
    const text = Array.isArray(content)
      ? content.map((entry) => ("text" in entry ? entry.text : "")).join("\n")
      : "text" in content
        ? content.text
        : "";
    const parsed = JSON.parse(text) as { tools: string[]; quickstart: { recommendedFirstTool: string } };

    expect(parsed.tools).toContain("traq_get_api_capabilities");
    expect(parsed.quickstart.recommendedFirstTool).toBe("traq_get_api_capabilities");
  });

  it("supports tool group template lookups", async () => {
    const templates = await resources.resourceTemplates?.({ extra: {} as never });
    expect(templates?.[0]?.uriTemplate).toBe("mastra://catalog/tools/{group}");

    const groupContent = await resources.getResourceContent({
      uri: "mastra://catalog/tools/traq",
      extra: {} as never,
    });
    const text = Array.isArray(groupContent)
      ? groupContent.map((entry) => ("text" in entry ? entry.text : "")).join("\n")
      : "text" in groupContent
        ? groupContent.text
        : "";
    const parsed = JSON.parse(text) as { tools: string[] };
    expect(parsed.tools.every((tool) => tool.startsWith("traq_"))).toBe(true);
  });
});


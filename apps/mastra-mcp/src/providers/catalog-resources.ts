import type { Resource, ResourceTemplate } from "@modelcontextprotocol/sdk/types";
import type { MCPRequestHandlerExtra, MCPServerResources } from "@mastra/mcp/server";
import type { ToolBundle } from "./fixture-tools.js";

const OVERVIEW_URI = "mastra://catalog/overview";
const TOOLS_URI = "mastra://catalog/tools";

interface ToolCatalog {
  server: string;
  bundleInstructions: string[];
  tools: string[];
  toolGroups: Record<string, string[]>;
  quickstart: {
    note: string;
    recommendedFirstTool: string;
    examples: string[];
  };
}

function groupName(toolName: string): string {
  if (toolName.startsWith("traq_")) return "traq";
  if (toolName.startsWith("get_demo_") || toolName.startsWith("read_fixture_")) {
    return "fixture";
  }
  return "other";
}

function buildToolCatalog(bundles: ToolBundle[]): ToolCatalog {
  const tools = bundles
    .flatMap((bundle) => Object.keys(bundle.tools))
    .sort((a, b) => a.localeCompare(b));

  const toolGroups = tools.reduce<Record<string, string[]>>((groups, tool) => {
    const key = groupName(tool);
    groups[key] = [...(groups[key] ?? []), tool];
    return groups;
  }, {});

  return {
    server: "mastra_local",
    bundleInstructions: bundles.map((bundle) => bundle.instructions),
    tools,
    toolGroups,
    quickstart: {
      note:
        "This MCP server primarily exposes tools. Even when resources are sparse, tool calls are available.",
      recommendedFirstTool: "traq_get_api_capabilities",
      examples: [
        "traq_get_api_capabilities",
        "traq_get_me",
        "traq_list_channels",
        "traq_search_messages",
      ],
    },
  };
}

function buildResourceList(): Resource[] {
  return [
    {
      uri: OVERVIEW_URI,
      name: "mastra_mcp_overview",
      title: "Mastra MCP Overview",
      mimeType: "text/markdown",
      description:
        "High-level MCP usage note and first-step guidance for this server.",
    },
    {
      uri: TOOLS_URI,
      name: "mastra_mcp_tool_catalog",
      title: "Mastra MCP Tool Catalog",
      mimeType: "application/json",
      description: "Lists available tool names and groups exposed by this server.",
    },
  ];
}

function buildResourceTemplates(): ResourceTemplate[] {
  return [
    {
      uriTemplate: "mastra://catalog/tools/{group}",
      name: "mastra_mcp_tool_group",
      title: "Mastra MCP Tool Group",
      mimeType: "application/json",
      description: "Tool list filtered by group. Supported groups: traq, fixture, other.",
    },
  ];
}

function renderOverview(catalog: ToolCatalog): string {
  return [
    "# Mastra MCP Overview",
    "",
    "This server exposes tool-first capabilities for local fixtures and traQ API access.",
    "",
    `- server: ${catalog.server}`,
    `- toolCount: ${catalog.tools.length}`,
    `- recommendedFirstTool: ${catalog.quickstart.recommendedFirstTool}`,
    "- note: Do not assume empty resources means no tools.",
    "",
    "## Recommended First Calls",
    ...catalog.quickstart.examples.map((tool) => `- ${tool}`),
  ].join("\n");
}

function readGroupFromUri(uri: string): string | undefined {
  const match = /^mastra:\/\/catalog\/tools\/([A-Za-z0-9_-]+)$/.exec(uri);
  return match?.[1];
}

function buildTextResponse(text: string): { text: string } {
  return { text };
}

export function buildCatalogResources(bundles: ToolBundle[]): MCPServerResources {
  const catalog = buildToolCatalog(bundles);

  return {
    listResources: async (_params: { extra: MCPRequestHandlerExtra }) =>
      buildResourceList(),
    resourceTemplates: async (_params: { extra: MCPRequestHandlerExtra }) =>
      buildResourceTemplates(),
    getResourceContent: async ({ uri }: { uri: string; extra: MCPRequestHandlerExtra }) => {
      if (uri === OVERVIEW_URI) {
        return buildTextResponse(renderOverview(catalog));
      }

      if (uri === TOOLS_URI) {
        return buildTextResponse(JSON.stringify(catalog, null, 2));
      }

      const requestedGroup = readGroupFromUri(uri);
      if (requestedGroup) {
        const tools = catalog.toolGroups[requestedGroup] ?? [];
        return buildTextResponse(
          JSON.stringify(
            {
              group: requestedGroup,
              toolCount: tools.length,
              tools,
            },
            null,
            2,
          ),
        );
      }

      throw new Error(`Unknown resource URI: ${uri}`);
    },
  };
}


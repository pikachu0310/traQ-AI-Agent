import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createTool } from "@mastra/core/tools";
import { MCPServer } from "@mastra/mcp";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, "../fixtures");

interface ServiceStatusFixture {
  updatedAt: string;
  environment: string;
  services: Record<
    string,
    {
      status: string;
      latencyMsP95: number;
      note: string;
    }
  >;
}

async function readServiceStatusFixture(): Promise<ServiceStatusFixture> {
  const raw = await readFile(path.join(fixturesDir, "service-status.json"), "utf-8");
  return JSON.parse(raw) as ServiceStatusFixture;
}

const getDemoServiceStatusTool = createTool({
  id: "get_demo_service_status",
  description:
    "Return demo service health from a local JSON fixture. Optionally narrow by service name.",
  inputSchema: z.object({
    service: z.string().optional().describe("Optional service name to filter."),
  }),
  execute: async ({ service }) => {
    const fixture = await readServiceStatusFixture();
    if (!service) {
      return fixture;
    }
    const serviceEntry = fixture.services[service];
    if (!serviceEntry) {
      return {
        updatedAt: fixture.updatedAt,
        environment: fixture.environment,
        requestedService: service,
        found: false,
        availableServices: Object.keys(fixture.services),
      };
    }
    return {
      updatedAt: fixture.updatedAt,
      environment: fixture.environment,
      requestedService: service,
      found: true,
      service: serviceEntry,
    };
  },
});

const readFixtureMarkdownTool = createTool({
  id: "read_fixture_markdown",
  description:
    "Read local markdown fixture and optionally return only lines containing a keyword.",
  inputSchema: z.object({
    keyword: z.string().optional().describe("Optional keyword filter."),
    maxLines: z.number().int().min(1).max(200).optional().default(40),
  }),
  execute: async ({ keyword, maxLines }) => {
    const raw = await readFile(path.join(fixturesDir, "internal-summary.md"), "utf-8");
    const lines = raw.split(/\r?\n/);
    const filtered = keyword
      ? lines.filter((line) => line.toLowerCase().includes(keyword.toLowerCase()))
      : lines;
    return {
      source: "fixtures/internal-summary.md",
      keyword: keyword ?? null,
      lineCount: filtered.length,
      content: filtered.slice(0, maxLines).join("\n"),
    };
  },
});

async function main(): Promise<void> {
  const server = new MCPServer({
    id: "traq-codex-mastra-mvp",
    name: "traQ Codex Mastra MVP MCP",
    version: "0.1.0",
    description: "Local Mastra MCP server for the traQ + Codex MVP.",
    instructions:
      "Use get_demo_service_status for service health and read_fixture_markdown for context text.",
    tools: {
      get_demo_service_status: getDemoServiceStatusTool,
      read_fixture_markdown: readFixtureMarkdownTool,
    },
  });

  await server.startStdio();
}

void main().catch((error) => {
  // stdio MCP requires stdout for protocol; send logs to stderr only.
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});

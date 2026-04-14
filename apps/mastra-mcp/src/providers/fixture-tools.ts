import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export type MastraTool = ReturnType<typeof createTool>;

export interface ToolBundle {
  tools: Record<string, MastraTool>;
  instructions: string;
}

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, "../../fixtures");

async function readServiceStatusFixture(): Promise<ServiceStatusFixture> {
  const raw = await readFile(path.join(fixturesDir, "service-status.json"), "utf-8");
  return JSON.parse(raw) as ServiceStatusFixture;
}

export function buildFixtureTools(): ToolBundle {
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

  return {
    tools: {
      get_demo_service_status: getDemoServiceStatusTool,
      read_fixture_markdown: readFixtureMarkdownTool,
    },
    instructions:
      "Use get_demo_service_status for local service health fixtures and read_fixture_markdown for local context text.",
  };
}

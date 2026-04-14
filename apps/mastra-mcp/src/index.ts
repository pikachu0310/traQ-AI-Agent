import { MCPServer } from "@mastra/mcp";
import { buildFixtureTools } from "./providers/fixture-tools.js";
import { buildTraqTools } from "./providers/traq-tools.js";

async function main(): Promise<void> {
  const bundles = [buildFixtureTools(), buildTraqTools(process.env)];

  const tools = Object.assign({}, ...bundles.map((bundle) => bundle.tools));
  const instructions = bundles.map((bundle) => bundle.instructions).join(" ");

  const server = new MCPServer({
    id: "traq-codex-mastra-mvp",
    name: "traQ Codex Mastra MVP MCP",
    version: "0.2.0",
    description:
      "Local Mastra MCP server for the traQ + Codex MVP with traQ API tool support.",
    instructions,
    tools,
  });

  await server.startStdio();
}

void main().catch((error) => {
  // stdio MCP requires stdout for protocol; send logs to stderr only.
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});

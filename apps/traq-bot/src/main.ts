import path from "node:path";
import { loadAppConfig } from "@mvp/shared";
import { CodexRunner } from "@mvp/codex-runner";
import type { BotAdapter } from "./adapters/types.js";
import { TraqMockAdapter } from "./adapters/traq-mock-adapter.js";
import { TraqRealAdapter } from "./adapters/traq-real-adapter.js";
import { BotService } from "./bot-service.js";

function createAdapterFromConfig(config: ReturnType<typeof loadAppConfig>): BotAdapter {
  if (config.mode === "real") {
    if (!config.traq.token) {
      throw new Error("BOT_MODE=real requires TRAQ_BOT_TOKEN");
    }
    return new TraqRealAdapter({
      token: config.traq.token,
      wsUrl: config.traq.wsUrl,
      apiBaseUrl: config.traq.apiBaseUrl,
      botUserId: config.traq.botUserId,
    });
  }

  return new TraqMockAdapter({
    channelId: config.mock.channelId,
    threadId: config.mock.threadId,
    userId: config.mock.userId,
    text: config.mock.text,
  });
}

async function main(): Promise<void> {
  const config = loadAppConfig();
  const adapter = createAdapterFromConfig(config);
  const codexHomeDir = path.resolve(config.codex.codexHomeTemplateDir);

  const runner = new CodexRunner({
    dataDir: config.dataDir,
    codexCommand: config.codex.command,
    codexWorkingDir: config.codexWorkingDir,
    codexModel: config.codex.model,
    codexReasoningEffort: config.codex.reasoningEffort,
    codexFeatureFlags: config.codex.enableFeatures,
    dangerousBypass: config.codex.dangerousBypass,
    codexHomeDir,
    codexAuthSourcePath: config.codex.authSourcePath,
    mcpServers: config.mcp.servers,
  });
  await runner.initialize();

  const service = new BotService(config.triggerPrefix, adapter, runner);
  await service.start();
}

void main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});

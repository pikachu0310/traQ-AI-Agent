import path from "node:path";
import os from "node:os";
import dotenv from "dotenv";
import type { BotMode } from "./types.js";

dotenv.config();

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function parseList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw || raw.trim() === "") return fallback;
  return raw.split(" ").map((entry) => entry.trim()).filter(Boolean);
}

function expandHomePath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolvePathFromCwd(cwd: string, raw: string): string {
  const expanded = expandHomePath(raw);
  if (path.isAbsolute(expanded)) return expanded;
  return path.resolve(cwd, expanded);
}

export interface AppConfig {
  mode: BotMode;
  triggerPrefix: string;
  dataDir: string;
  codexWorkingDir: string;
  codex: {
    command: string;
    model?: string;
    reasoningEffort?: string;
    dangerousBypass: boolean;
    codexHomeTemplateDir: string;
    authSourcePath?: string;
  };
  mcp: {
    command: string;
    args: string[];
    cwd: string;
  };
  traq: {
    token?: string;
    wsUrl: string;
    apiBaseUrl: string;
    botUserId?: string;
  };
  mock: {
    channelId: string;
    threadId?: string;
    userId: string;
    text: string;
  };
}

export function loadAppConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): AppConfig {
  const projectRoot = env.INIT_CWD ? path.resolve(env.INIT_CWD) : cwd;
  const mode = (env.BOT_MODE ?? "mock") as BotMode;
  const dataDir = resolvePathFromCwd(projectRoot, env.BOT_DATA_DIR ?? "./data");
  const codexWorkingDir = resolvePathFromCwd(
    projectRoot,
    env.CODEX_WORKING_DIR ?? ".",
  );

  return {
    mode,
    triggerPrefix: env.BOT_TRIGGER_PREFIX ?? "/codex",
    dataDir,
    codexWorkingDir,
    codex: {
      command: env.CODEX_COMMAND ?? "codex",
      model: env.CODEX_MODEL || undefined,
      reasoningEffort: env.CODEX_REASONING_EFFORT || undefined,
      dangerousBypass: parseBool(env.CODEX_DANGEROUS_BYPASS, true),
      codexHomeTemplateDir: resolvePathFromCwd(
        projectRoot,
        env.CODEX_HOME_TEMPLATE_DIR ?? "./data/runtime/codex-home",
      ),
      authSourcePath: resolvePathFromCwd(
        projectRoot,
        env.CODEX_AUTH_SOURCE ?? "~/.codex/auth.json",
      ),
    },
    mcp: {
      command: env.MCP_SERVER_COMMAND ?? "node",
      args: parseList(env.MCP_SERVER_ARGS, [
        "--import",
        "tsx",
        "apps/mastra-mcp/src/index.ts",
      ]),
      cwd: resolvePathFromCwd(projectRoot, env.MCP_SERVER_CWD ?? "."),
    },
    traq: {
      token: env.TRAQ_BOT_TOKEN || undefined,
      wsUrl: env.TRAQ_WS_URL ?? "wss://q.trap.jp/api/v3/bots/ws",
      apiBaseUrl: env.TRAQ_API_BASE_URL ?? "https://q.trap.jp/api/v3",
      botUserId: env.TRAQ_BOT_USER_ID || undefined,
    },
    mock: {
      channelId: env.MOCK_CHANNEL_ID ?? "mock-channel",
      threadId: env.MOCK_THREAD_ID || undefined,
      userId: env.MOCK_USER_ID ?? "mock-user",
      text:
        env.MOCK_TEXT ??
        "/codex Mastra MCP の demo service status を取得して要約してください。",
    },
  };
}

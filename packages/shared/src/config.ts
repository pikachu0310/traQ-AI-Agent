import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import dotenv from "dotenv";
import type { BotMode } from "./types.js";

function hasFile(dir: string, fileName: string): boolean {
  return fs.existsSync(path.join(dir, fileName));
}

function findProjectRootFromCwd(cwd: string): string {
  let current = path.resolve(cwd);

  while (true) {
    if (hasFile(current, "pnpm-workspace.yaml")) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(cwd);
    }
    current = parent;
  }
}

function loadEnvFromProjectRoot(projectRoot: string): void {
  dotenv.config({ path: path.join(projectRoot, ".env"), override: false });
}

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
    env: Record<string, string>;
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
  const projectRoot = findProjectRootFromCwd(cwd);
  if (env === process.env) {
    loadEnvFromProjectRoot(projectRoot);
  }

  const resolvedEnv = env === process.env ? process.env : env;
  const mode = (resolvedEnv.BOT_MODE ?? "mock") as BotMode;
  const dataDir = resolvePathFromCwd(
    projectRoot,
    resolvedEnv.BOT_DATA_DIR ?? "./data",
  );
  const codexWorkingDir = resolvePathFromCwd(
    projectRoot,
    resolvedEnv.CODEX_WORKING_DIR ?? ".",
  );
  const mcpEnv: Record<string, string> = {};
  for (const key of [
    "TRAQ_BOT_TOKEN",
    "TRAQ_API_BASE_URL",
    "TRAQ_MCP_ENABLE_WRITE_TOOLS",
    "TRAQ_MCP_DEFAULT_LIMIT",
  ]) {
    const value = resolvedEnv[key];
    if (value !== undefined && value !== "") {
      mcpEnv[key] = value;
    }
  }

  return {
    mode,
    triggerPrefix: resolvedEnv.BOT_TRIGGER_PREFIX ?? "/codex",
    dataDir,
    codexWorkingDir,
    codex: {
      command: resolvedEnv.CODEX_COMMAND ?? "codex",
      model: resolvedEnv.CODEX_MODEL || undefined,
      reasoningEffort: resolvedEnv.CODEX_REASONING_EFFORT || undefined,
      dangerousBypass: parseBool(resolvedEnv.CODEX_DANGEROUS_BYPASS, true),
      codexHomeTemplateDir: resolvePathFromCwd(
        projectRoot,
        resolvedEnv.CODEX_HOME_TEMPLATE_DIR ?? "./data/runtime/codex-home",
      ),
      authSourcePath: resolvePathFromCwd(
        projectRoot,
        resolvedEnv.CODEX_AUTH_SOURCE ?? "~/.codex/auth.json",
      ),
    },
    mcp: {
      command: resolvedEnv.MCP_SERVER_COMMAND ?? "node",
      args: parseList(resolvedEnv.MCP_SERVER_ARGS, [
        "--import",
        "tsx",
        "apps/mastra-mcp/src/index.ts",
      ]),
      cwd: resolvePathFromCwd(projectRoot, resolvedEnv.MCP_SERVER_CWD ?? "."),
      env: mcpEnv,
    },
    traq: {
      token: resolvedEnv.TRAQ_BOT_TOKEN || undefined,
      wsUrl: resolvedEnv.TRAQ_WS_URL ?? "wss://q.trap.jp/api/v3/bots/ws",
      apiBaseUrl: resolvedEnv.TRAQ_API_BASE_URL ?? "https://q.trap.jp/api/v3",
      botUserId: resolvedEnv.TRAQ_BOT_USER_ID || undefined,
    },
    mock: {
      channelId: resolvedEnv.MOCK_CHANNEL_ID ?? "mock-channel",
      threadId: resolvedEnv.MOCK_THREAD_ID || undefined,
      userId: resolvedEnv.MOCK_USER_ID ?? "mock-user",
      text:
        resolvedEnv.MOCK_TEXT ??
        "/codex Mastra MCP の demo service status を取得して要約してください。",
    },
  };
}

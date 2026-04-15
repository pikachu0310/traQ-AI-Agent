import path from "node:path";
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";

export interface CodexHomeConfigInput {
  codexHomeDir: string;
  workspaceDir: string;
  mcpCommand: string;
  mcpArgs: string[];
  mcpCwd: string;
  mcpEnv: Record<string, string>;
  authSourcePath?: string;
}

function escapeTomlString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function tomlArray(values: string[]): string {
  const escaped = values.map((entry) => `"${escapeTomlString(entry)}"`).join(", ");
  return `[${escaped}]`;
}

function tomlKey(input: string): string {
  return /^[A-Za-z0-9_-]+$/.test(input) ? input : `"${escapeTomlString(input)}"`;
}

function buildConfigToml(input: CodexHomeConfigInput): string {
  const workspace = escapeTomlString(input.workspaceDir);
  const mcpCwd = escapeTomlString(input.mcpCwd);
  const envEntries = Object.entries(input.mcpEnv).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return [
    `[projects."${workspace}"]`,
    `trust_level = "trusted"`,
    "",
    `[mcp_servers.mastra_local]`,
    `command = "${escapeTomlString(input.mcpCommand)}"`,
    `args = ${tomlArray(input.mcpArgs)}`,
    `cwd = "${mcpCwd}"`,
    ...(envEntries.length > 0
      ? [
          "",
          `[mcp_servers.mastra_local.env]`,
          ...envEntries.map(
            ([key, value]) => `${tomlKey(key)} = "${escapeTomlString(value)}"`,
          ),
        ]
      : []),
    "",
  ].join("\n");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function prepareCodexHome(input: CodexHomeConfigInput): Promise<void> {
  await mkdir(input.codexHomeDir, { recursive: true });
  await writeFile(
    path.join(input.codexHomeDir, "config.toml"),
    buildConfigToml(input),
    "utf-8",
  );

  if (!input.authSourcePath) return;
  if (!(await exists(input.authSourcePath))) return;

  await copyFile(input.authSourcePath, path.join(input.codexHomeDir, "auth.json"));
}

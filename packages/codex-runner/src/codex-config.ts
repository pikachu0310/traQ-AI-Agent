import path from "node:path";
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";

export interface CodexHomeConfigInput {
  codexHomeDir: string;
  workspaceDir: string;
  mcpCommand: string;
  mcpArgs: string[];
  mcpCwd: string;
  authSourcePath?: string;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function tomlArray(values: string[]): string {
  const escaped = values.map((entry) => `"${escapeTomlString(entry)}"`).join(", ");
  return `[${escaped}]`;
}

function buildConfigToml(input: CodexHomeConfigInput): string {
  const workspace = escapeTomlString(input.workspaceDir);
  const mcpCwd = escapeTomlString(input.mcpCwd);
  return [
    `[projects."${workspace}"]`,
    `trust_level = "trusted"`,
    "",
    `[mcp_servers.mastra_local]`,
    `command = "${escapeTomlString(input.mcpCommand)}"`,
    `args = ${tomlArray(input.mcpArgs)}`,
    `cwd = "${mcpCwd}"`,
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

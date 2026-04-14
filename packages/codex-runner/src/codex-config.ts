import path from "node:path";
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import type { McpServerConfig } from "@mvp/shared";

export interface CodexHomeConfigInput {
  codexHomeDir: string;
  workspaceDir: string;
  mcpServers: McpServerConfig[];
  authSourcePath?: string;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function tomlArray(values: string[]): string {
  const escaped = values.map((entry) => `"${escapeTomlString(entry)}"`).join(", ");
  return `[${escaped}]`;
}

function renderMcpServerConfig(server: McpServerConfig): string[] {
  return [
    `[mcp_servers."${escapeTomlString(server.name)}"]`,
    `command = "${escapeTomlString(server.command)}"`,
    `args = ${tomlArray(server.args)}`,
    `cwd = "${escapeTomlString(server.cwd)}"`,
    "",
  ];
}

function buildConfigToml(input: CodexHomeConfigInput): string {
  const workspace = escapeTomlString(input.workspaceDir);
  const mcpServerBlocks = input.mcpServers.flatMap((server) =>
    renderMcpServerConfig(server),
  );
  return [
    `[projects."${workspace}"]`,
    `trust_level = "trusted"`,
    "",
    ...mcpServerBlocks,
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

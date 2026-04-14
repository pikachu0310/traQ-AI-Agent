import path from "node:path";
import { spawn } from "node:child_process";
import type {
  CodexRunRequest,
  CodexRunResult,
  RunnerProgressEvent,
} from "@mvp/shared";
import { FileStateStore, toRelativeDataPath } from "@mvp/shared";
import { prepareCodexHome } from "./codex-config.js";
import { CodexEventParser } from "./event-parser.js";

export interface CodexRunnerOptions {
  dataDir: string;
  codexCommand: string;
  codexWorkingDir: string;
  codexModel?: string;
  codexReasoningEffort?: string;
  dangerousBypass: boolean;
  codexHomeDir: string;
  codexAuthSourcePath?: string;
  mcpServerCommand: string;
  mcpServerArgs: string[];
  mcpServerCwd: string;
}

function truncateText(text: string, maxLength = 300): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function buildCodexArgs(
  prompt: string,
  resumeSessionId: string | undefined,
  options: CodexRunnerOptions,
): string[] {
  const commonArgs = [
    "--json",
    "--color",
    "never",
    "--skip-git-repo-check",
    "--enable",
    "rmcp_client",
  ];

  if (options.dangerousBypass) {
    commonArgs.push("--dangerously-bypass-approvals-and-sandbox");
  }
  if (options.codexModel) {
    commonArgs.push("--model", options.codexModel);
  }
  if (options.codexReasoningEffort) {
    commonArgs.push(
      "--config",
      `model_reasoning_effort="${options.codexReasoningEffort}"`,
    );
  }

  if (resumeSessionId) {
    return ["exec", ...commonArgs, "resume", resumeSessionId, prompt];
  }
  return ["exec", ...commonArgs, prompt];
}

export class CodexRunner {
  private readonly parser = new CodexEventParser();
  private readonly store: FileStateStore;

  constructor(private readonly options: CodexRunnerOptions) {
    this.store = new FileStateStore(options.dataDir);
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await prepareCodexHome({
      codexHomeDir: this.options.codexHomeDir,
      workspaceDir: this.options.codexWorkingDir,
      mcpCommand: this.options.mcpServerCommand,
      mcpArgs: this.options.mcpServerArgs,
      mcpCwd: this.options.mcpServerCwd,
      authSourcePath: this.options.codexAuthSourcePath,
    });
  }

  async run(
    request: CodexRunRequest,
    onProgress: (event: RunnerProgressEvent) => Promise<void> = async () => {},
  ): Promise<CodexRunResult> {
    const startedAt = new Date().toISOString();
    const args = buildCodexArgs(
      request.prompt,
      request.resumeSessionId,
      this.options,
    );

    let stdoutBuffer = "";
    let rawJsonl = "";
    let latestAgentMessage = "";
    let sessionId = request.resumeSessionId;
    let stderrText = "";
    let progressQueue = Promise.resolve();

    const emitProgress = (event: RunnerProgressEvent): void => {
      progressQueue = progressQueue
        .then(async () => {
          await onProgress(event);
        })
        .catch(() => {
          // Keep queue chain alive even when user callback fails.
        });
    };

    const child = spawn(this.options.codexCommand, args, {
      cwd: this.options.codexWorkingDir,
      env: {
        ...process.env,
        CODEX_HOME: this.options.codexHomeDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    child.stdout.on("data", (chunk: string) => {
      rawJsonl += chunk;
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const parsed = this.parser.parseLine(line);
        if (parsed.sessionId) {
          sessionId = parsed.sessionId;
        }
        if (parsed.latestAgentMessage) {
          latestAgentMessage = parsed.latestAgentMessage;
        }
        for (const event of parsed.progressEvents) {
          emitProgress(event);
        }
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderrText += chunk;
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });

    if (stdoutBuffer.trim()) {
      rawJsonl += `${stdoutBuffer}\n`;
      const parsed = this.parser.parseLine(stdoutBuffer.trim());
      if (parsed.sessionId) {
        sessionId = parsed.sessionId;
      }
      if (parsed.latestAgentMessage) {
        latestAgentMessage = parsed.latestAgentMessage;
      }
      for (const event of parsed.progressEvents) {
        emitProgress(event);
      }
    }

    if (exitCode !== 0) {
      const message = stderrText.trim()
        ? truncateText(stderrText.trim())
        : `Codex command exited with code ${exitCode}`;
      emitProgress({ type: "error", message });
      await progressQueue;
      throw new Error(message);
    }

    const completedAt = new Date().toISOString();
    const rawLogAbsolutePath = await this.store.prepareRawSessionLogPath(
      request.conversationKey,
      sessionId,
      startedAt,
    );
    await this.store.writeRawSessionLog(rawLogAbsolutePath, rawJsonl);
    await progressQueue;

    return {
      sessionId,
      finalAnswer: latestAgentMessage || "Codex の最終回答を取得できませんでした。",
      rawLogPath: toRelativeDataPath(this.options.dataDir, rawLogAbsolutePath),
      startedAt,
      completedAt,
    };
  }

  getStore(): FileStateStore {
    return this.store;
  }

  getCodexHomePath(): string {
    return path.resolve(this.options.codexHomeDir);
  }
}

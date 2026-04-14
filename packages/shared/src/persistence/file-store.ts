import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { ConversationRecord } from "../types.js";

export interface DataLayout {
  baseDir: string;
  conversationsDir: string;
  codexSessionsDir: string;
  runtimeDir: string;
}

function safeFileName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export class FileStateStore {
  private readonly layout: DataLayout;

  constructor(baseDataDir: string) {
    this.layout = {
      baseDir: baseDataDir,
      conversationsDir: path.join(baseDataDir, "conversations"),
      codexSessionsDir: path.join(baseDataDir, "codex-sessions"),
      runtimeDir: path.join(baseDataDir, "runtime"),
    };
  }

  getLayout(): DataLayout {
    return this.layout;
  }

  async initialize(): Promise<void> {
    await ensureDir(this.layout.baseDir);
    await ensureDir(this.layout.conversationsDir);
    await ensureDir(this.layout.codexSessionsDir);
    await ensureDir(this.layout.runtimeDir);
  }

  getConversationFilePath(conversationKey: string): string {
    return path.join(
      this.layout.conversationsDir,
      `${safeFileName(conversationKey)}.json`,
    );
  }

  async loadConversation(
    conversationKey: string,
  ): Promise<ConversationRecord | null> {
    return await readJsonFile<ConversationRecord>(
      this.getConversationFilePath(conversationKey),
    );
  }

  async saveConversation(record: ConversationRecord): Promise<void> {
    await writeJsonFile(
      this.getConversationFilePath(record.conversationKey),
      record,
    );
  }

  async prepareRawSessionLogPath(
    conversationKey: string,
    sessionId?: string,
    startedAt?: string,
  ): Promise<string> {
    const ts = (startedAt ?? new Date().toISOString()).replace(/[:.]/g, "-");
    const fileName = `${ts}_${safeFileName(sessionId ?? "pending")}.jsonl`;
    const logDir = path.join(
      this.layout.codexSessionsDir,
      safeFileName(conversationKey),
    );
    await ensureDir(logDir);
    return path.join(logDir, fileName);
  }

  async writeRawSessionLog(filePath: string, rawJsonl: string): Promise<void> {
    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, rawJsonl, "utf-8");
  }
}

export function toRelativeDataPath(baseDataDir: string, filePath: string): string {
  return path.relative(baseDataDir, filePath);
}

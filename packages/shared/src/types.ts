export type BotMode = "real" | "mock";

export interface InboundTraqMessage {
  messageId: string;
  channelId: string;
  threadId?: string | null;
  userId: string;
  text: string;
  createdAt?: string;
}

export interface OutboundTarget {
  channelId: string;
  threadId?: string | null;
}

export interface ConversationRunSummary {
  startedAt: string;
  completedAt?: string;
  prompt: string;
  sessionId?: string;
  rawLogPath: string;
}

export interface ConversationRecord {
  conversationKey: string;
  updatedAt: string;
  lastSessionId?: string;
  lastPrompt: string;
  lastRawLogPath: string;
  runs: ConversationRunSummary[];
}

export type RunnerProgressEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "turn_started" }
  | {
      type: "tool_call_started";
      server: string;
      tool: string;
      arguments?: unknown;
    }
  | {
      type: "tool_call_finished";
      server: string;
      tool: string;
      status: "completed" | "failed";
      detail?: string;
    }
  | { type: "command_started"; command: string }
  | { type: "command_finished"; command: string; exitCode?: number }
  | { type: "agent_message"; text: string }
  | { type: "error"; message: string }
  | {
      type: "run_completed";
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
      };
    };

export interface CodexRunRequest {
  conversationKey: string;
  prompt: string;
  resumeSessionId?: string;
}

export interface CodexRunResult {
  sessionId?: string;
  finalAnswer: string;
  rawLogPath: string;
  startedAt: string;
  completedAt: string;
}

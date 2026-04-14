import type { InboundTraqMessage, OutboundTarget } from "@mvp/shared";
import type { BotAdapter } from "./types.js";

interface MockAdapterConfig {
  channelId: string;
  threadId?: string;
  userId: string;
  text: string;
}

export class TraqMockAdapter implements BotAdapter {
  constructor(private readonly config: MockAdapterConfig) {}

  async start(
    onMessage: (message: InboundTraqMessage) => Promise<void>,
  ): Promise<void> {
    const inbound: InboundTraqMessage = {
      messageId: `mock-${Date.now()}`,
      channelId: this.config.channelId,
      threadId: this.config.threadId,
      userId: this.config.userId,
      text: this.config.text,
      createdAt: new Date().toISOString(),
    };
    process.stdout.write(`[mock:receive] ${inbound.text}\n`);
    await onMessage(inbound);
  }

  async sendMessage(target: OutboundTarget, content: string): Promise<void> {
    process.stdout.write(
      `[mock:send][channel=${target.channelId}] ${content}\n`,
    );
  }
}

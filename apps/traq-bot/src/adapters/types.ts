import type { InboundTraqMessage, OutboundTarget } from "@mvp/shared";

export interface BotAdapter {
  start(onMessage: (message: InboundTraqMessage) => Promise<void>): Promise<void>;
  sendMessage(target: OutboundTarget, content: string): Promise<void>;
}

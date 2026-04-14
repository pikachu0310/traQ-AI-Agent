import { Api, Client } from "traq-bot-ts";
import type { InboundTraqMessage, OutboundTarget } from "@mvp/shared";
import type { BotAdapter } from "./types.js";

interface RealAdapterConfig {
  token: string;
  wsUrl: string;
  apiBaseUrl: string;
  botUserId?: string;
}

export class TraqRealAdapter implements BotAdapter {
  private readonly client: Client;
  private readonly api: Api<string>;

  constructor(private readonly config: RealAdapterConfig) {
    this.client = new Client({
      token: config.token,
      address: config.wsUrl,
    });
    this.api = new Api<string>({
      baseUrl: config.apiBaseUrl,
      securityWorker: (token) =>
        token
          ? {
              headers: {
                Authorization: `Bearer ${token}`,
              },
            }
          : undefined,
    });
    this.api.setSecurityData(config.token);
  }

  async start(
    onMessage: (message: InboundTraqMessage) => Promise<void>,
  ): Promise<void> {
    this.client.on("MESSAGE_CREATED", (event) => {
      void (async () => {
        const wsMessage = event.body.message;
        if (this.config.botUserId && wsMessage.user.id === this.config.botUserId) {
          return;
        }
        if (wsMessage.user.bot && !this.config.botUserId) {
          return;
        }

        let threadId: string | null | undefined = undefined;
        try {
          const detail = await this.api.messages.getMessage(wsMessage.id);
          threadId = detail.data.threadId;
        } catch {
          // If lookup fails, continue with channel-based conversation key.
        }

        await onMessage({
          messageId: wsMessage.id,
          channelId: wsMessage.channelId,
          threadId,
          userId: wsMessage.user.id,
          text: wsMessage.text,
          createdAt: wsMessage.createdAt.toISOString(),
        });
      })().catch((error) => {
        process.stderr.write(`traQ event handler error: ${String(error)}\n`);
      });
    });

    await this.client.listen(() => {
      process.stderr.write("traQ websocket connected.\n");
    });
  }

  async sendMessage(target: OutboundTarget, content: string): Promise<void> {
    await this.api.channels.postMessage(target.channelId, {
      content,
      embed: true,
    });
  }
}

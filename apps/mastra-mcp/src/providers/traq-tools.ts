import { Api, type Channel, type Message, type MyUserDetail, type User } from "traq-bot-ts";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ToolBundle } from "./fixture-tools.js";

const DEFAULT_TRAQ_API_BASE_URL = "https://q.trap.jp/api/v3";
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function truncate(text: string, maxLength = 240): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function flattenErrorMessage(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (Array.isArray(value)) {
    return value.map((entry) => flattenErrorMessage(entry)).filter(Boolean).join(" | ");
  }
  const record = asRecord(value);
  if (!record) return String(value);
  return [
    record.message,
    record.error,
    record.detail,
    record.title,
    record.reason,
    record.text,
  ]
    .map((entry) => flattenErrorMessage(entry))
    .filter(Boolean)
    .join(" | ");
}

function formatTraqApiError(error: unknown): string {
  const record = asRecord(error);
  const status = typeof record?.status === "number" ? record.status : undefined;
  const body = flattenErrorMessage(record?.error ?? record?.response ?? record ?? error);
  if (status !== undefined && body) {
    return `traQ API request failed (status=${status}): ${truncate(body, 400)}`;
  }
  if (body) {
    return `traQ API request failed: ${truncate(body, 400)}`;
  }
  return "traQ API request failed with unknown error.";
}

export interface TraqMcpConfig {
  token?: string;
  apiBaseUrl: string;
  enableWriteTools: boolean;
  defaultLimit: number;
}

export function parseTraqMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
): TraqMcpConfig {
  const configuredLimit = parsePositiveInt(env.TRAQ_MCP_DEFAULT_LIMIT, DEFAULT_LIMIT);
  return {
    token: env.TRAQ_BOT_TOKEN || undefined,
    apiBaseUrl: env.TRAQ_API_BASE_URL ?? DEFAULT_TRAQ_API_BASE_URL,
    enableWriteTools: parseBool(env.TRAQ_MCP_ENABLE_WRITE_TOOLS, false),
    defaultLimit: Math.min(configuredLimit, MAX_LIMIT),
  };
}

export function buildChannelPathMap(channels: Channel[]): Map<string, string> {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const resolved = new Map<string, string>();
  const resolving = new Set<string>();

  const resolvePath = (channelId: string): string => {
    const cached = resolved.get(channelId);
    if (cached) return cached;

    const channel = byId.get(channelId);
    if (!channel) return "#unknown";

    if (resolving.has(channelId)) {
      return `#${channel.name}`;
    }

    resolving.add(channelId);

    const parentPath =
      channel.parentId && byId.has(channel.parentId)
        ? resolvePath(channel.parentId)
        : "";
    const path = parentPath ? `${parentPath}/${channel.name}` : `#${channel.name}`;

    resolving.delete(channelId);
    resolved.set(channelId, path);
    return path;
  };

  for (const channel of channels) {
    resolvePath(channel.id);
  }

  return resolved;
}

function summarizeChannel(channel: Channel, pathMap: Map<string, string>): {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  archived: boolean;
  force: boolean;
  topic: string;
  childrenCount: number;
} {
  return {
    id: channel.id,
    name: channel.name,
    path: pathMap.get(channel.id) ?? `#${channel.name}`,
    parentId: channel.parentId,
    archived: channel.archived,
    force: channel.force,
    topic: channel.topic,
    childrenCount: channel.children.length,
  };
}

function summarizeMessage(message: Message): {
  id: string;
  channelId: string;
  threadId: string | null;
  userId: string;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  stampCount: number;
  content: string;
} {
  return {
    id: message.id,
    channelId: message.channelId,
    threadId: message.threadId,
    userId: message.userId,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    pinned: message.pinned,
    stampCount: message.stamps.length,
    content: truncate(message.content, 600),
  };
}

function summarizeUser(
  user: Pick<User, "id" | "name" | "displayName" | "bot" | "state" | "iconFileId" | "updatedAt">,
): {
  id: string;
  name: string;
  displayName: string;
  bot: boolean;
  state: number;
  iconFileId: string;
  updatedAt: string;
} {
  return {
    id: user.id,
    name: user.name,
    displayName: user.displayName,
    bot: user.bot,
    state: user.state,
    iconFileId: user.iconFileId,
    updatedAt: user.updatedAt,
  };
}

export function buildTraqTools(env: NodeJS.ProcessEnv = process.env): ToolBundle {
  const config = parseTraqMcpConfig(env);

  let client: Api<string> | null = null;

  const getClient = (): Api<string> => {
    if (client) return client;

    if (!config.token) {
      throw new Error(
        "TRAQ_BOT_TOKEN が設定されていないため traQ API を呼び出せません。 .env に TRAQ_BOT_TOKEN を設定してください。",
      );
    }

    client = new Api<string>({
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
    client.setSecurityData(config.token);

    return client;
  };

  const withTraqApi = async <T>(action: (api: Api<string>) => Promise<T>): Promise<T> => {
    try {
      return await action(getClient());
    } catch (error) {
      throw new Error(formatTraqApiError(error));
    }
  };

  const getCapabilitiesTool = createTool({
    id: "traq_get_api_capabilities",
    description:
      "Show traQ API MCP runtime capabilities, environment-derived settings, and available tool categories.",
    inputSchema: z.object({}),
    execute: async () => ({
      service: "traQ",
      apiBaseUrl: config.apiBaseUrl,
      tokenConfigured: Boolean(config.token),
      writeToolsEnabled: config.enableWriteTools,
      defaultLimit: config.defaultLimit,
      maxLimit: MAX_LIMIT,
      openApiSource:
        "https://raw.githubusercontent.com/traPtitech/traQ/master/docs/v3-api.yaml",
      availableToolGroups: {
        read: [
          "traq_get_me",
          "traq_list_channels",
          "traq_get_channel",
          "traq_get_message",
          "traq_get_channel_messages",
          "traq_search_messages",
          "traq_list_users",
        ],
        write: config.enableWriteTools
          ? ["traq_post_message", "traq_post_direct_message"]
          : [],
      },
    }),
  });

  const getMeTool = createTool({
    id: "traq_get_me",
    description: "Get my traQ user details for the currently configured bot token.",
    inputSchema: z.object({}),
    execute: async () =>
      withTraqApi(async (api) => {
        const me = (await api.users.getMe()).data as MyUserDetail;
        return {
          ...summarizeUser(me),
          homeChannel: me.homeChannel,
          lastOnline: me.lastOnline,
          permissions: me.permissions,
          groups: me.groups,
          tags: me.tags,
        };
      }),
  });

  const listChannelsTool = createTool({
    id: "traq_list_channels",
    description: "List traQ channels with optional filtering. Includes computed path names.",
    inputSchema: z.object({
      includeDm: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to include DM channels in the metadata."),
      includeArchived: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether archived channels should be included in returned list."),
      nameContains: z
        .string()
        .optional()
        .describe("Case-insensitive substring filter against channel path."),
      limit: z.number().int().min(1).max(200).optional().default(config.defaultLimit),
    }),
    execute: async ({ includeDm, includeArchived, nameContains, limit }) =>
      withTraqApi(async (api) => {
        const effectiveLimit = limit ?? config.defaultLimit;
        const channelList = (await api.channels.getChannels({ "include-dm": includeDm }))
          .data;
        const publicChannels = includeArchived
          ? channelList.public
          : channelList.public.filter((channel) => !channel.archived);
        const pathMap = buildChannelPathMap(publicChannels);

        const query = nameContains?.toLowerCase().trim();
        const filtered = query
          ? publicChannels.filter((channel) =>
              (pathMap.get(channel.id) ?? `#${channel.name}`).toLowerCase().includes(query),
            )
          : publicChannels;

        const sorted = [...filtered].sort((a, b) => {
          const aPath = pathMap.get(a.id) ?? `#${a.name}`;
          const bPath = pathMap.get(b.id) ?? `#${b.name}`;
          return aPath.localeCompare(bPath, "ja");
        });

        return {
          totalPublicChannels: channelList.public.length,
          returnedPublicChannels: Math.min(sorted.length, effectiveLimit),
          dmCount: channelList.dm?.length ?? 0,
          channels: sorted
            .slice(0, effectiveLimit)
            .map((channel) => summarizeChannel(channel, pathMap)),
        };
      }),
  });

  const getChannelTool = createTool({
    id: "traq_get_channel",
    description: "Get details for one traQ channel by channel ID.",
    inputSchema: z.object({
      channelId: z.string().min(1).describe("Target channel UUID."),
    }),
    execute: async ({ channelId }) =>
      withTraqApi(async (api) => {
        const channel = (await api.channels.getChannel(channelId)).data;
        const allPublic = (await api.channels.getChannels()).data.public;
        const pathMap = buildChannelPathMap(allPublic);
        return summarizeChannel(channel, pathMap);
      }),
  });

  const getMessageTool = createTool({
    id: "traq_get_message",
    description: "Get one traQ message by message ID.",
    inputSchema: z.object({
      messageId: z.string().min(1).describe("Target message UUID."),
    }),
    execute: async ({ messageId }) =>
      withTraqApi(async (api) => {
        const message = (await api.messages.getMessage(messageId)).data;
        return summarizeMessage(message);
      }),
  });

  const getChannelMessagesTool = createTool({
    id: "traq_get_channel_messages",
    description: "Get messages in a channel. Use for timeline inspection and context collection.",
    inputSchema: z.object({
      channelId: z.string().min(1).describe("Target channel UUID."),
      limit: z.number().int().min(1).max(200).optional().default(config.defaultLimit),
      offset: z.number().int().min(0).optional().default(0),
      since: z
        .string()
        .datetime()
        .optional()
        .describe("RFC3339 datetime lower bound (inclusive=false behavior is server default)."),
      until: z.string().datetime().optional().describe("RFC3339 datetime upper bound."),
      order: z.enum(["asc", "desc"]).optional().default("desc"),
    }),
    execute: async ({ channelId, limit, offset, since, until, order }) =>
      withTraqApi(async (api) => {
        const messages = (
          await api.channels.getMessages(channelId, {
            limit,
            offset,
            since,
            until,
            order,
          })
        ).data;

        return {
          channelId,
          returned: messages.length,
          messages: messages.map((message) => summarizeMessage(message)),
        };
      }),
  });

  const searchMessagesTool = createTool({
    id: "traq_search_messages",
    description:
      "Search traQ messages by word and optional filters. Requires at least one search condition.",
    inputSchema: z.object({
      word: z.string().optional(),
      channelId: z.string().optional().describe("Maps to `in` query parameter."),
      fromUserId: z.string().optional().describe("Maps to `from` query parameter."),
      toUserId: z.string().optional().describe("Maps to `to` query parameter."),
      citationMessageId: z.string().optional().describe("Maps to `citation` query parameter."),
      after: z.string().datetime().optional(),
      before: z.string().datetime().optional(),
      bot: z.boolean().optional(),
      hasUrl: z.boolean().optional(),
      hasAttachments: z.boolean().optional(),
      hasImage: z.boolean().optional(),
      hasVideo: z.boolean().optional(),
      hasAudio: z.boolean().optional(),
      offset: z.number().int().min(0).optional().default(0),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional().default(config.defaultLimit),
      sort: z
        .enum(["createdAt", "-createdAt", "updatedAt", "-updatedAt"])
        .optional()
        .default("-createdAt"),
    }),
    execute: async (input) =>
      withTraqApi(async (api) => {
        const hasCondition = [
          input.word,
          input.channelId,
          input.fromUserId,
          input.toUserId,
          input.citationMessageId,
          input.after,
          input.before,
          input.bot,
          input.hasUrl,
          input.hasAttachments,
          input.hasImage,
          input.hasVideo,
          input.hasAudio,
        ].some((value) => value !== undefined && value !== "");

        if (!hasCondition) {
          throw new Error(
            "少なくとも1つは検索条件を指定してください (word, channelId, fromUserId など)。",
          );
        }

        const result = (
          await api.messages.searchMessages({
            word: input.word,
            in: input.channelId,
            from: input.fromUserId,
            to: input.toUserId,
            citation: input.citationMessageId,
            after: input.after,
            before: input.before,
            bot: input.bot,
            hasURL: input.hasUrl,
            hasAttachments: input.hasAttachments,
            hasImage: input.hasImage,
            hasVideo: input.hasVideo,
            hasAudio: input.hasAudio,
            offset: input.offset,
            limit: input.limit,
            sort: input.sort,
          })
        ).data;

        return {
          totalHits: result.totalHits,
          returned: result.hits.length,
          messages: result.hits.map((message) => summarizeMessage(message)),
        };
      }),
  });

  const listUsersTool = createTool({
    id: "traq_list_users",
    description: "List traQ users. Optionally filter by exact account name.",
    inputSchema: z.object({
      name: z.string().optional().describe("Exact account name filter."),
      includeSuspended: z.boolean().optional().default(false),
      limit: z.number().int().min(1).max(500).optional().default(100),
    }),
    execute: async ({ name, includeSuspended, limit }) =>
      withTraqApi(async (api) => {
        const effectiveLimit = limit ?? 100;
        const users = (
          await api.users.getUsers({
            name,
            "include-suspended": includeSuspended,
          })
        ).data;

        return {
          total: users.length,
          returned: Math.min(users.length, effectiveLimit),
          users: users.slice(0, effectiveLimit).map((user) => summarizeUser(user)),
        };
      }),
  });

  const postMessageTool = createTool({
    id: "traq_post_message",
    description:
      "Post a message to a traQ channel. Disabled by default unless TRAQ_MCP_ENABLE_WRITE_TOOLS=true.",
    inputSchema: z.object({
      channelId: z.string().min(1),
      content: z.string().min(1).max(10000),
      embed: z.boolean().optional().default(true),
    }),
    execute: async ({ channelId, content, embed }) => {
      if (!config.enableWriteTools) {
        throw new Error(
          "書き込みツールは無効です。TRAQ_MCP_ENABLE_WRITE_TOOLS=true を設定して有効化してください。",
        );
      }
      return withTraqApi(async (api) => {
        const message = (await api.channels.postMessage(channelId, { content, embed })).data;
        return {
          posted: true,
          message: summarizeMessage(message),
        };
      });
    },
  });

  const postDirectMessageTool = createTool({
    id: "traq_post_direct_message",
    description:
      "Post a direct message to a traQ user. Disabled by default unless TRAQ_MCP_ENABLE_WRITE_TOOLS=true.",
    inputSchema: z.object({
      userId: z.string().min(1),
      content: z.string().min(1).max(10000),
      embed: z.boolean().optional().default(true),
    }),
    execute: async ({ userId, content, embed }) => {
      if (!config.enableWriteTools) {
        throw new Error(
          "書き込みツールは無効です。TRAQ_MCP_ENABLE_WRITE_TOOLS=true を設定して有効化してください。",
        );
      }
      return withTraqApi(async (api) => {
        const message = (await api.users.postDirectMessage(userId, { content, embed })).data;
        return {
          posted: true,
          message: summarizeMessage(message),
        };
      });
    },
  });

  const tools = {
    traq_get_api_capabilities: getCapabilitiesTool,
    traq_get_me: getMeTool,
    traq_list_channels: listChannelsTool,
    traq_get_channel: getChannelTool,
    traq_get_message: getMessageTool,
    traq_get_channel_messages: getChannelMessagesTool,
    traq_search_messages: searchMessagesTool,
    traq_list_users: listUsersTool,
    ...(config.enableWriteTools
      ? {
          traq_post_message: postMessageTool,
          traq_post_direct_message: postDirectMessageTool,
        }
      : {}),
  };

  return {
    tools,
    instructions: config.enableWriteTools
      ? "Use traQ tools (traq_*) for safe API access. Read and write tools are enabled."
      : "Use traQ tools (traq_*) for safe API access. Write tools are disabled unless TRAQ_MCP_ENABLE_WRITE_TOOLS=true.",
  };
}

import { readFile } from "node:fs/promises";
import { createTool } from "@mastra/core/tools";
import { MCPServer } from "@mastra/mcp";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface OpenApiReference {
  $ref: string;
}

interface OpenApiParameter {
  name: string;
  in: "query" | "header" | "path" | "cookie";
  required?: boolean;
  description?: string;
  schema?: unknown;
  style?: string;
  explode?: boolean;
}

interface OpenApiRequestBody {
  required?: boolean;
  description?: string;
  content?: Record<
    string,
    {
      schema?: unknown;
    }
  >;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: Array<OpenApiParameter | OpenApiReference>;
  requestBody?: OpenApiRequestBody | OpenApiReference;
}

interface OpenApiPathItem {
  parameters?: Array<OpenApiParameter | OpenApiReference>;
  get?: OpenApiOperation | OpenApiReference;
  post?: OpenApiOperation | OpenApiReference;
  put?: OpenApiOperation | OpenApiReference;
  patch?: OpenApiOperation | OpenApiReference;
  delete?: OpenApiOperation | OpenApiReference;
  options?: OpenApiOperation | OpenApiReference;
  head?: OpenApiOperation | OpenApiReference;
}

interface OpenApiDocument {
  openapi?: string;
  info?: Record<string, unknown>;
  paths: Record<string, OpenApiPathItem | OpenApiReference>;
  components?: Record<string, unknown>;
}

interface OperationDescriptor {
  operationId: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  deprecated: boolean;
  parameters: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
}

interface TraqMcpConfig {
  apiBaseUrl: string;
  botToken?: string;
  openApiUrl: string;
  openApiLocalPath?: string;
  operationAllowlist: Set<string> | null;
  specCacheTtlMs: number;
  requestTimeoutMs: number;
}

interface OperationListFilter {
  tag?: string;
  query?: string;
  includeDeprecated: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function hasRef(value: unknown): value is OpenApiReference {
  const record = asRecord(value);
  return Boolean(record && typeof record.$ref === "string");
}

function resolveJsonPointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    throw new Error(`Unsupported $ref format: ${ref}`);
  }
  const tokens = ref
    .slice(2)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const token of tokens) {
    const record = asRecord(current);
    if (!record || !(token in record)) {
      throw new Error(`Failed to resolve $ref path: ${ref}`);
    }
    current = record[token];
  }
  return current;
}

function resolveReference(root: OpenApiDocument, value: unknown): unknown {
  let current = value;
  const visited = new Set<string>();
  while (hasRef(current)) {
    const ref = current.$ref;
    if (visited.has(ref)) {
      throw new Error(`Detected cyclic $ref: ${ref}`);
    }
    visited.add(ref);
    current = resolveJsonPointer(root, ref);
  }
  return current;
}

function normalizeParameter(
  root: OpenApiDocument,
  value: OpenApiParameter | OpenApiReference,
): OpenApiParameter | null {
  const resolved = resolveReference(root, value);
  const record = asRecord(resolved);
  if (!record) return null;
  if (typeof record.name !== "string" || typeof record.in !== "string") {
    return null;
  }
  const location = record.in;
  if (!["query", "header", "path", "cookie"].includes(location)) {
    return null;
  }
  return {
    name: record.name,
    in: location as OpenApiParameter["in"],
    required: typeof record.required === "boolean" ? record.required : undefined,
    description:
      typeof record.description === "string" ? record.description : undefined,
    schema: record.schema,
    style: typeof record.style === "string" ? record.style : undefined,
    explode: typeof record.explode === "boolean" ? record.explode : undefined,
  };
}

function normalizeRequestBody(
  root: OpenApiDocument,
  value: OpenApiRequestBody | OpenApiReference | undefined,
): OpenApiRequestBody | undefined {
  if (!value) return undefined;
  const resolved = resolveReference(root, value);
  const record = asRecord(resolved);
  if (!record) return undefined;
  const contentRecord = asRecord(record.content);
  const content: OpenApiRequestBody["content"] = contentRecord
    ? Object.fromEntries(
        Object.entries(contentRecord).map(([contentType, schemaEntry]) => {
          const schemaRecord = asRecord(schemaEntry);
          return [
            contentType,
            {
              schema: schemaRecord?.schema,
            },
          ];
        }),
      )
    : undefined;
  return {
    required: typeof record.required === "boolean" ? record.required : undefined,
    description:
      typeof record.description === "string" ? record.description : undefined,
    content,
  };
}

function mergeParameters(
  pathParameters: OpenApiParameter[],
  operationParameters: OpenApiParameter[],
): OpenApiParameter[] {
  const merged = [...pathParameters];
  for (const parameter of operationParameters) {
    const idx = merged.findIndex(
      (entry) => entry.name === parameter.name && entry.in === parameter.in,
    );
    if (idx >= 0) {
      merged[idx] = parameter;
    } else {
      merged.push(parameter);
    }
  }
  return merged;
}

function operationMatchesFilter(
  operation: OperationDescriptor,
  filter: OperationListFilter,
): boolean {
  if (!filter.includeDeprecated && operation.deprecated) return false;
  if (filter.tag && !operation.tags.includes(filter.tag)) return false;
  if (!filter.query) return true;
  const query = filter.query.toLowerCase();
  return [
    operation.operationId,
    operation.summary ?? "",
    operation.description ?? "",
    operation.path,
    operation.tags.join(" "),
  ]
    .join("\n")
    .toLowerCase()
    .includes(query);
}

function pickHeaderMap(headers: Headers): Record<string, string> {
  return Object.fromEntries(Array.from(headers.entries()));
}

function hasHeaderKey(headers: Record<string, string>, key: string): boolean {
  const target = key.toLowerCase();
  return Object.keys(headers).some((headerKey) => headerKey.toLowerCase() === target);
}

function serializePath(
  pathTemplate: string,
  pathParams: Record<string, string | number | boolean>,
): string {
  const replaced = pathTemplate.replace(/\{([^}]+)\}/g, (_full, rawKey) => {
    const key = String(rawKey);
    const value = pathParams[key];
    if (value === undefined || value === null) {
      throw new Error(`Missing required path parameter: ${key}`);
    }
    return encodeURIComponent(String(value));
  });
  const unresolved = replaced.match(/\{[^}]+\}/g);
  if (unresolved && unresolved.length > 0) {
    throw new Error(`Unresolved path parameters: ${unresolved.join(", ")}`);
  }
  return replaced;
}

function appendQuery(
  url: URL,
  query: Record<string, unknown> | undefined,
): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry === undefined || entry === null) continue;
        url.searchParams.append(key, String(entry));
      }
      continue;
    }
    if (typeof value === "object") {
      url.searchParams.append(key, JSON.stringify(value));
      continue;
    }
    url.searchParams.append(key, String(value));
  }
}

function coerceBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

class TraqOpenApiRegistry {
  private cache:
    | {
        loadedAt: number;
        spec: OpenApiDocument;
        operationsById: Map<string, OperationDescriptor>;
      }
    | undefined;

  constructor(private readonly config: TraqMcpConfig) {}

  private async fetchSpecText(): Promise<string> {
    if (this.config.openApiLocalPath) {
      return readFile(this.config.openApiLocalPath, "utf-8");
    }

    const response = await fetch(this.config.openApiUrl, {
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch traQ OpenAPI (${response.status} ${response.statusText})`,
      );
    }
    return response.text();
  }

  private parseSpec(text: string): OpenApiDocument {
    const parsed = parseYaml(text) as unknown;
    const record = asRecord(parsed);
    if (!record) {
      throw new Error("OpenAPI document is not an object.");
    }
    const paths = asRecord(record.paths);
    if (!paths) {
      throw new Error("OpenAPI document does not contain `paths`.");
    }
    return {
      openapi: typeof record.openapi === "string" ? record.openapi : undefined,
      info: asRecord(record.info),
      paths: paths as OpenApiDocument["paths"],
      components: asRecord(record.components),
    };
  }

  private buildOperationMap(spec: OpenApiDocument): Map<string, OperationDescriptor> {
    const operations = new Map<string, OperationDescriptor>();

    for (const [pathName, rawPathItem] of Object.entries(spec.paths)) {
      const pathItem = asRecord(resolveReference(spec, rawPathItem));
      if (!pathItem) continue;

      const pathParametersRaw = Array.isArray(pathItem.parameters)
        ? pathItem.parameters
        : [];
      const pathParameters = pathParametersRaw
        .map((entry) => normalizeParameter(spec, entry as OpenApiParameter | OpenApiReference))
        .filter((entry): entry is OpenApiParameter => Boolean(entry));

      for (const method of HTTP_METHODS) {
        const rawOperation = pathItem[method];
        if (!rawOperation) continue;
        const operationRecord = asRecord(resolveReference(spec, rawOperation));
        if (!operationRecord) continue;

        const operationIdBase =
          typeof operationRecord.operationId === "string" &&
          operationRecord.operationId.trim() !== ""
            ? operationRecord.operationId.trim()
            : `${method}_${pathName}`;
        let operationId = operationIdBase;
        let index = 2;
        while (operations.has(operationId)) {
          operationId = `${operationIdBase}__${index}`;
          index += 1;
        }

        const operationParametersRaw = Array.isArray(operationRecord.parameters)
          ? operationRecord.parameters
          : [];
        const operationParameters = operationParametersRaw
          .map((entry) =>
            normalizeParameter(spec, entry as OpenApiParameter | OpenApiReference),
          )
          .filter((entry): entry is OpenApiParameter => Boolean(entry));
        const mergedParameters = mergeParameters(pathParameters, operationParameters);
        const requestBody = normalizeRequestBody(
          spec,
          operationRecord.requestBody as OpenApiRequestBody | OpenApiReference | undefined,
        );

        const tags = Array.isArray(operationRecord.tags)
          ? operationRecord.tags.filter((tag): tag is string => typeof tag === "string")
          : [];

        operations.set(operationId, {
          operationId,
          method,
          path: pathName,
          summary:
            typeof operationRecord.summary === "string"
              ? operationRecord.summary
              : undefined,
          description:
            typeof operationRecord.description === "string"
              ? operationRecord.description
              : undefined,
          tags,
          deprecated: operationRecord.deprecated === true,
          parameters: mergedParameters,
          requestBody,
        });
      }
    }

    return operations;
  }

  private async ensureLoaded(): Promise<void> {
    const now = Date.now();
    if (this.cache && now - this.cache.loadedAt <= this.config.specCacheTtlMs) {
      return;
    }

    const text = await this.fetchSpecText();
    const spec = this.parseSpec(text);
    const operationsById = this.buildOperationMap(spec);
    this.cache = {
      loadedAt: now,
      spec,
      operationsById,
    };
  }

  private isAllowedOperation(operationId: string): boolean {
    if (!this.config.operationAllowlist) return true;
    return this.config.operationAllowlist.has(operationId);
  }

  async listOperations(filter: OperationListFilter): Promise<OperationDescriptor[]> {
    await this.ensureLoaded();
    const operations = Array.from(this.cache?.operationsById.values() ?? []).filter(
      (operation) =>
        this.isAllowedOperation(operation.operationId) &&
        operationMatchesFilter(operation, filter),
    );
    operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
    return operations;
  }

  async getOperation(operationId: string): Promise<OperationDescriptor | undefined> {
    await this.ensureLoaded();
    const operation = this.cache?.operationsById.get(operationId);
    if (!operation) return undefined;
    if (!this.isAllowedOperation(operation.operationId)) return undefined;
    return operation;
  }

  async getMetadata(): Promise<{
    openapiVersion?: string;
    title?: string;
    version?: string;
  }> {
    await this.ensureLoaded();
    const info = this.cache?.spec.info;
    return {
      openapiVersion: this.cache?.spec.openapi,
      title: typeof info?.title === "string" ? info.title : undefined,
      version: typeof info?.version === "string" ? info.version : undefined,
    };
  }
}

function loadConfig(env: NodeJS.ProcessEnv = process.env): TraqMcpConfig {
  const allowOperationIds = parseCsv(env.TRAQ_MCP_ALLOWED_OPERATION_IDS);
  return {
    apiBaseUrl: coerceBaseUrl(env.TRAQ_API_BASE_URL ?? "https://q.trap.jp/api/v3"),
    botToken: env.TRAQ_BOT_TOKEN || undefined,
    openApiUrl:
      env.TRAQ_OPENAPI_URL ??
      "https://raw.githubusercontent.com/traPtitech/traQ/master/docs/v3-api.yaml",
    openApiLocalPath: env.TRAQ_OPENAPI_LOCAL_PATH || undefined,
    operationAllowlist:
      allowOperationIds.length > 0 ? new Set(allowOperationIds) : null,
    specCacheTtlMs: parsePositiveInt(env.TRAQ_OPENAPI_CACHE_TTL_MS, 300_000),
    requestTimeoutMs: parsePositiveInt(env.TRAQ_OPENAPI_FETCH_TIMEOUT_MS, 15_000),
  };
}

const primitivePathValueSchema = z.union([z.string(), z.number(), z.boolean()]);

function formatOperationSummary(operation: OperationDescriptor): Record<string, unknown> {
  return {
    operationId: operation.operationId,
    method: operation.method.toUpperCase(),
    path: operation.path,
    summary: operation.summary ?? null,
    tags: operation.tags,
    deprecated: operation.deprecated,
    parameterCount: operation.parameters.length,
    hasRequestBody: Boolean(operation.requestBody?.content),
  };
}

function formatOperationDetail(operation: OperationDescriptor): Record<string, unknown> {
  return {
    ...formatOperationSummary(operation),
    description: operation.description ?? null,
    parameters: operation.parameters.map((parameter) => ({
      name: parameter.name,
      in: parameter.in,
      required: parameter.required ?? false,
      description: parameter.description ?? null,
      schema: parameter.schema ?? null,
      style: parameter.style ?? null,
      explode: parameter.explode ?? null,
    })),
    requestBody: operation.requestBody
      ? {
          required: operation.requestBody.required ?? false,
          description: operation.requestBody.description ?? null,
          contentTypes: Object.keys(operation.requestBody.content ?? {}),
          content: operation.requestBody.content ?? {},
        }
      : null,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const registry = new TraqOpenApiRegistry(config);

  const listTraqOperationsTool = createTool({
    id: "list_traq_operations",
    description:
      "List traQ OpenAPI operations. Filter by tag/query before calling an operation.",
    inputSchema: z.object({
      tag: z.string().optional().describe("Filter by operation tag."),
      query: z
        .string()
        .optional()
        .describe("Case-insensitive keyword match over operation metadata."),
      limit: z.number().int().min(1).max(200).optional().default(50),
      includeDeprecated: z.boolean().optional().default(false),
    }),
    execute: async ({ tag, query, limit, includeDeprecated }) => {
      const resolvedLimit = limit ?? 50;
      const resolvedIncludeDeprecated = includeDeprecated ?? false;
      const metadata = await registry.getMetadata();
      const operations = await registry.listOperations({
        tag,
        query,
        includeDeprecated: resolvedIncludeDeprecated,
      });
      return {
        openapi: metadata,
        total: operations.length,
        returned: Math.min(resolvedLimit, operations.length),
        operations: operations.slice(0, resolvedLimit).map((operation) =>
          formatOperationSummary(operation),
        ),
      };
    },
  });

  const describeTraqOperationTool = createTool({
    id: "describe_traq_operation",
    description:
      "Return parameter and request-body details for a single traQ OpenAPI operation.",
    inputSchema: z.object({
      operationId: z.string().min(1).describe("OpenAPI operationId."),
    }),
    execute: async ({ operationId }) => {
      const operation = await registry.getOperation(operationId);
      if (!operation) {
        const suggestions = await registry.listOperations({
          query: operationId,
          tag: undefined,
          includeDeprecated: true,
        });
        return {
          found: false,
          operationId,
          suggestions: suggestions.slice(0, 20).map((entry) => entry.operationId),
        };
      }
      return {
        found: true,
        operation: formatOperationDetail(operation),
      };
    },
  });

  const callTraqOperationTool = createTool({
    id: "call_traq_operation",
    description:
      "Call traQ REST API by OpenAPI operationId with path/query/body arguments.",
    inputSchema: z.object({
      operationId: z.string().min(1).describe("OpenAPI operationId."),
      pathParams: z
        .record(primitivePathValueSchema)
        .optional()
        .default({})
        .describe("Path parameters for placeholders like {channelId}."),
      query: z
        .record(z.any())
        .optional()
        .describe("Query parameters. Arrays are expanded as repeated keys."),
      body: z.any().optional().describe("JSON request body."),
      headers: z
        .record(z.string())
        .optional()
        .describe("Additional request headers."),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, validate/build request and skip HTTP call."),
    }),
    execute: async ({ operationId, pathParams, query, body, headers, dryRun }) => {
      const resolvedPathParams = pathParams ?? {};
      const resolvedDryRun = dryRun ?? false;
      const operation = await registry.getOperation(operationId);
      if (!operation) {
        return {
          ok: false,
          error: `Unknown or disallowed operationId: ${operationId}`,
        };
      }

      const requestPath = serializePath(operation.path, resolvedPathParams);
      const url = new URL(`${config.apiBaseUrl}${requestPath}`);
      appendQuery(url, query);

      const requestHeaders: Record<string, string> = {
        Accept: "application/json",
        ...(headers ?? {}),
      };
      if (!hasHeaderKey(requestHeaders, "Authorization")) {
        if (config.botToken) {
          requestHeaders.Authorization = `Bearer ${config.botToken}`;
        }
      }

      let requestBody: string | undefined;
      if (body !== undefined) {
        if (typeof body === "string") {
          requestBody = body;
        } else {
          requestBody = JSON.stringify(body);
          if (!hasHeaderKey(requestHeaders, "Content-Type")) {
            requestHeaders["Content-Type"] = "application/json";
          }
        }
      }

      const requestSummary = {
        operationId: operation.operationId,
        method: operation.method.toUpperCase(),
        url: url.toString(),
        headers: requestHeaders,
        body: body ?? null,
      };

      if (resolvedDryRun) {
        return {
          ok: true,
          dryRun: true,
          request: requestSummary,
        };
      }

      if (!hasHeaderKey(requestHeaders, "Authorization")) {
        return {
          ok: false,
          error:
            "Authorization header is missing. Set TRAQ_BOT_TOKEN or pass headers.Authorization explicitly.",
          request: requestSummary,
        };
      }

      const response = await fetch(url, {
        method: operation.method.toUpperCase(),
        headers: requestHeaders,
        body: requestBody,
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });

      const contentType = response.headers.get("content-type") ?? "";
      const responseText = await response.text();
      let responseBody: unknown = responseText;
      if (contentType.includes("application/json") && responseText.trim() !== "") {
        try {
          responseBody = JSON.parse(responseText) as unknown;
        } catch {
          responseBody = responseText;
        }
      }

      return {
        ok: response.ok,
        dryRun: false,
        request: requestSummary,
        response: {
          status: response.status,
          statusText: response.statusText,
          headers: pickHeaderMap(response.headers),
          body: responseBody,
        },
      };
    },
  });

  const server = new MCPServer({
    id: "traq-openapi-mcp",
    name: "traQ OpenAPI MCP",
    version: "0.1.0",
    description:
      "MCP server for calling traQ APIs using operationIds loaded from OpenAPI.",
    instructions: [
      "First call `list_traq_operations` to discover operationIds.",
      "Then call `describe_traq_operation` for required params/request body.",
      "Finally call `call_traq_operation` with path/query/body values.",
    ].join(" "),
    tools: {
      list_traq_operations: listTraqOperationsTool,
      describe_traq_operation: describeTraqOperationTool,
      call_traq_operation: callTraqOperationTool,
    },
  });

  await server.startStdio();
}

void main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});

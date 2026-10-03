/**
 * dsh-mcp-unified-panel —— unifiedMcpManager Typert wire manifest。
 */
import { z } from "zod";
import { strictCodec } from "../codec.js";
import { mcpServerInputSchema } from "./model.js";
/**
 * 网关边界用的宽松 payload schema：只要求能拿到一个 JSON 值，字段校验全部交给
 * handler（save/removeServer/setEnabled/test 各自 parse 一次严格 schema）。
 *
 * 背景：边界 codec 内嵌 mcpServerInputSchema 时，名称不合法会在边界上就被拒，
 * 宿主只回 `gateway/input-invalid: typert gateway: mcpManager/save: wire field
 * "payload" failed boundary validation` —— zod 的字段说明到不了前端。
 * 校验下沉后抛出的是 `describeSchemaError` 生成的中文错误，用户能看懂。
 */
const boundaryPayloadSchema = z.unknown();
const fiberPhaseSchema = z.enum(["pending", "loading", "active", "failed", "unloading"]).nullable();
const reconnectViewSchema = z.object({
    enabled: z.boolean(),
    initialDelayMs: z.number(),
    maxDelayMs: z.number(),
    maxAttempts: z.number()
});
export const oauthInfoSchema = z.object({
    credentialRef: z.string().optional(),
    credentialRefPresent: z.boolean(),
    login: z.object({
        state: z.string(),
        username: z.string().optional(),
        email: z.string().optional(),
        expiresAt: z.number().optional(),
        scopes: z.array(z.string()).optional(),
        note: z.string().optional(),
    }).passthrough(),
}).passthrough();
export const mcpServerViewSchema = z.object({
    serverName: z.string(),
    transport: z.enum(["stdio", "streamable-http", "oauth-http", "unknown"]),
    enabled: z.boolean(),
    entryId: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    envKeys: z.array(z.string()).default([]),
    cwd: z.string().optional(),
    url: z.string().optional(),
    headerKeys: z.array(z.string()).default([]),
    toolCallTimeoutMs: z.number().default(60000),
    failOnStartupError: z.boolean().default(false),
    reconnect: reconnectViewSchema.default({ enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 }),
    managed: z.boolean().default(true),
    fiberPhase: fiberPhaseSchema,
    toolCount: z.number().int().nonnegative(),
    kind: z.string().optional(),
    clientName: z.string().optional(),
    credentialRefPresent: z.boolean().optional(),
    oauth: oauthInfoSchema.optional(),
}).passthrough();
export const mcpOtherRowSchema = z.object({ id: z.string(), name: z.string().optional() }).passthrough();
export const mcpListResultSchema = z.object({
    servers: z.array(mcpServerViewSchema),
    externalServers: z.array(mcpServerViewSchema),
    others: z.array(mcpOtherRowSchema).default([]),
    thirdParty: z.array(mcpServerViewSchema).default([]),
    patch: z.object({
        path: z.string(),
        ok: z.boolean(),
        error: z.string().nullable()
    })
});
export const mcpSavePayloadSchema = z.object({
    input: mcpServerInputSchema,
    previousServerName: z.string().optional(),
    enabled: z.boolean().default(true)
});
export const mcpSaveResultSchema = z.object({
    server: mcpServerViewSchema,
    reconciled: z.boolean()
});
export const mcpRemovePayloadSchema = z.object({
    serverName: z.string()
});
export const mcpRemoveResultSchema = z.object({
    ok: z.boolean()
});
export const mcpSetEnabledPayloadSchema = z.object({
    serverName: z.string(),
    enabled: z.boolean()
});
export const mcpTestPayloadSchema = z.union([
    mcpServerInputSchema,
    z.object({ serverName: z.string() })
]);
const mcpToolSchema = z.object({
    name: z.string(),
    description: z.string().optional()
});
export const mcpTestResultSchema = z.object({
    ok: z.boolean(),
    tools: z.array(mcpToolSchema),
    error: z.string().optional(),
    note: z.string().optional(),
}).passthrough();
export const oauthAddPayloadSchema = z.object({
    serverName: z.string(),
    url: z.string(),
});
export const oauthRemovePayloadSchema = z.object({ serverName: z.string() });
export const pluginListResultSchema = z.object({
    plugins: z.array(z.object({ name: z.string(), version: z.string(), desc: z.string() }).passthrough()),
}).passthrough();
export const oauthStatusResultSchema = z.object({
    serverName: z.string(),
    entryId: z.string().optional(),
    credentialRef: z.string().optional(),
    credentialRefPresent: z.boolean(),
    login: z.object({
        state: z.string(),
        username: z.string().optional(),
        email: z.string().optional(),
        expiresAt: z.number().optional(),
        scopes: z.array(z.string()).optional(),
        note: z.string().optional(),
    }).passthrough(),
    connection: z.unknown().optional(),
}).passthrough();
export const MCP_MANIFEST = {
    package: "dsh-mcp-unified-panel",
    face: "host",
    schemas: [],
    invocations: [
        {
            id: "dsh-mcp-unified-panel#unifiedMcpManager/list",
            service: "unifiedMcpManager",
            namespace: "unifiedMcpManager",
            method: "list",
            invocation: { kind: "direct" },
            parameters: [],
            result: strictCodec("dsh-mcp-unified-panel#McpListResult", mcpListResultSchema)
        },
        {
            id: "dsh-mcp-unified-panel#unifiedMcpManager/save",
            service: "unifiedMcpManager",
            namespace: "unifiedMcpManager",
            method: "save",
            invocation: { kind: "direct" },
            parameters: [
                { name: "payload", wire: "payload", source: "json", codec: strictCodec("dsh-mcp-unified-panel#McpSavePayload", boundaryPayloadSchema) }
            ],
            result: strictCodec("dsh-mcp-unified-panel#McpSaveResult", mcpSaveResultSchema)
        },
        {
            id: "dsh-mcp-unified-panel#unifiedMcpManager/removeServer",
            service: "unifiedMcpManager",
            namespace: "unifiedMcpManager",
            method: "removeServer",
            invocation: { kind: "direct" },
            parameters: [
                { name: "payload", wire: "payload", source: "json", codec: strictCodec("dsh-mcp-unified-panel#McpRemovePayload", boundaryPayloadSchema) }
            ],
            result: strictCodec("dsh-mcp-unified-panel#McpRemoveResult", mcpRemoveResultSchema)
        },
        {
            id: "dsh-mcp-unified-panel#unifiedMcpManager/setEnabled",
            service: "unifiedMcpManager",
            namespace: "unifiedMcpManager",
            method: "setEnabled",
            invocation: { kind: "direct" },
            parameters: [
                { name: "payload", wire: "payload", source: "json", codec: strictCodec("dsh-mcp-unified-panel#McpSetEnabledPayload", boundaryPayloadSchema) }
            ],
            result: strictCodec("dsh-mcp-unified-panel#McpSaveResult", mcpSaveResultSchema)
        },
        {
            id: "dsh-mcp-unified-panel#unifiedMcpManager/test",
            service: "unifiedMcpManager",
            namespace: "unifiedMcpManager",
            method: "test",
            invocation: { kind: "direct" },
            parameters: [
                { name: "payload", wire: "payload", source: "json", codec: strictCodec("dsh-mcp-unified-panel#McpTestPayload", boundaryPayloadSchema) }
            ],
            result: strictCodec("dsh-mcp-unified-panel#McpTestResult", mcpTestResultSchema)
        },
        {
            id: "dsh-mcp-unified-panel#unifiedMcpManager/reload",
            service: "unifiedMcpManager",
            namespace: "unifiedMcpManager",
            method: "reload",
            invocation: { kind: "direct" },
            parameters: [],
            result: strictCodec("dsh-mcp-unified-panel#McpListResult", mcpListResultSchema)
        },
        {
            id: "dsh-mcp-unified-panel#unifiedMcpManager/oauthAdd",
            service: "unifiedMcpManager",
            namespace: "unifiedMcpManager",
            method: "oauthAdd",
            invocation: { kind: "direct" },
            parameters: [
                { name: "payload", wire: "payload", source: "json", codec: strictCodec("dsh-mcp-unified-panel#OauthAddPayload", boundaryPayloadSchema) }
            ],
            result: strictCodec("dsh-mcp-unified-panel#OauthAddResult", z.object({ added: z.string(), entryId: z.string() }).passthrough())
        },
        {
            id: "dsh-mcp-unified-panel#unifiedMcpManager/oauthRemove",
            service: "unifiedMcpManager",
            namespace: "unifiedMcpManager",
            method: "oauthRemove",
            invocation: { kind: "direct" },
            parameters: [
                { name: "payload", wire: "payload", source: "json", codec: strictCodec("dsh-mcp-unified-panel#OauthRemovePayload", boundaryPayloadSchema) }
            ],
            result: strictCodec("dsh-mcp-unified-panel#OauthRemoveResult", z.object({ removed: z.string() }).passthrough())
        },
        {
            id: "dsh-mcp-unified-panel#unifiedMcpManager/plugins",
            service: "unifiedMcpManager",
            namespace: "unifiedMcpManager",
            method: "plugins",
            invocation: { kind: "direct" },
            parameters: [],
            result: strictCodec("dsh-mcp-unified-panel#PluginListResult", pluginListResultSchema)
        },
        {
            id: "dsh-mcp-unified-panel#unifiedMcpManager/oauthStatus",
            service: "unifiedMcpManager",
            namespace: "unifiedMcpManager",
            method: "oauthStatus",
            invocation: { kind: "direct" },
            parameters: [
                { name: "payload", wire: "payload", source: "json", codec: strictCodec("dsh-mcp-unified-panel#OauthStatusPayload", boundaryPayloadSchema) }
            ],
            result: strictCodec("dsh-mcp-unified-panel#OauthStatusResult", oauthStatusResultSchema)
        }
    ],
    model: { services: [], events: [], objects: [] }
};

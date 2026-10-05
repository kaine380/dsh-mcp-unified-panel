/**
 * OAuth-enabled Streamable HTTP MCP client for DeepSeek Harness.
 *
 * The plugin preserves the tool discovery, naming, execution, and reconnect
 * behavior of `@deepseek-ai/dsh-mcp-client`, while adding an interactive
 * OAuth authorization-code flow backed by the Harness credential service.
 *
 * @module @dsh-external/dsh-oauth-mcp-client
 */
import z from '@deepseek-ai/schemastery';
import { credentialRef } from './dsh.js';
import { createOAuthRuntime } from './oauth.js';
import { RECONNECT_DEFAULTS, resolveReconnectPolicy, startConnection } from './connection.js';
import { registerConnection } from './registry.js';
/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-mcp-unified-panel/oauth-client';
/** Services required by the OAuth client. */
export const inject = ['tools', 'credentials'];
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const Reconnect = z.object({
    enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
    initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.initialDelayMs),
    maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.maxDelayMs),
    maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(RECONNECT_DEFAULTS.maxAttempts),
});
/** Cordis configuration schema. */
export const Config = z.object({
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    url: z.string().required(),
    credentialRef: z.string(),
    scope: z.string(),
    headers: z.dict(String).default({}),
    callbackPort: z.number().step(1).min(0).max(65_535).default(0),
    authorizationTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_AUTHORIZATION_TIMEOUT_MS),
    toolCallTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(true),
    reconnect: Reconnect,
});
const activeServerNames = new WeakMap();
/** Derive a valid credential reference when the deployment does not name one. */
export function defaultCredentialRef(serverName) {
    return `DSH_MCP_OAUTH_${serverName.toUpperCase().replaceAll('-', '_')}`;
}
/** Model guidance for discovering and executing capabilities from one MCP server. */
export function mcpGuidance(serverName) {
    const prefix = `mcp__${serverName}__`;
    return `Use tools beginning with ${prefix} when the user asks about this MCP server. `
        + `When ${prefix}search_capabilities is available, call it before claiming that no matching capability exists. `
        + `When calling ${prefix}execute_capability, pass the complete capability name returned by search_capabilities, not a shorter action_id. `
        + 'Present the returned capabilities or execution result clearly to the user.';
}
/** Resolve defaults and reject unsafe or internally conflicting configuration. */
export function resolveConfig(config) {
    if (!SERVER_NAME_PATTERN.test(config.serverName)) {
        throw new Error(`dsh-oauth-mcp-client: serverName must match ${String(SERVER_NAME_PATTERN)}`);
    }
    const url = new URL(config.url);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        throw new Error('dsh-oauth-mcp-client: url must use HTTPS, except for loopback development endpoints');
    }
    if (url.username || url.password)
        throw new Error('dsh-oauth-mcp-client: url must not contain credentials');
    const headers = { ...(config.headers ?? {}) };
    if (Object.keys(headers).some(key => key.toLowerCase() === 'authorization')) {
        throw new Error('dsh-oauth-mcp-client: headers.Authorization is owned by OAuth and must not be configured');
    }
    const callbackPort = config.callbackPort ?? 0;
    if (!Number.isInteger(callbackPort) || callbackPort < 0 || callbackPort > 65_535) {
        throw new Error('dsh-oauth-mcp-client: callbackPort must be an integer from 0 through 65535');
    }
    const authorizationTimeoutMs = config.authorizationTimeoutMs ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS;
    const toolCallTimeoutMs = config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
    for (const [key, value] of Object.entries({ authorizationTimeoutMs, toolCallTimeoutMs })) {
        if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
            throw new Error(`dsh-oauth-mcp-client: ${key} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
        }
    }
    const ref = config.credentialRef ?? defaultCredentialRef(config.serverName);
    credentialRef(ref);
    const scope = config.scope?.trim();
    if (config.scope !== undefined && !scope)
        throw new Error('dsh-oauth-mcp-client: scope must not be empty');
    return Object.freeze({
        serverName: config.serverName,
        url: url.toString(),
        credentialRef: ref,
        ...(scope === undefined ? {} : { scope }),
        headers,
        callbackPort,
        authorizationTimeoutMs,
        toolCallTimeoutMs,
        failOnStartupError: config.failOnStartupError ?? true,
    });
}
/** Connect, authorize when needed, and publish the remote MCP tools. */
export async function apply(ctx, config) {
    const resolved = resolveConfig(config);
    const reconnect = resolveReconnectPolicy(config.reconnect, `dsh-oauth-mcp-client(${resolved.serverName}): reconnect`);
    ctx.effect(() => {
        let names = activeServerNames.get(ctx.root);
        if (!names) {
            names = new Set();
            activeServerNames.set(ctx.root, names);
        }
        if (names.has(resolved.serverName)) {
            throw new Error(`dsh-oauth-mcp-client: serverName "${resolved.serverName}" is already in use by another instance`);
        }
        names.add(resolved.serverName);
        return () => void names.delete(resolved.serverName);
    }, 'dsh-oauth-mcp-client.serverName');
    const entryId = ctx.fiber.entry?.options?.id;
    if (typeof entryId !== 'string' || !entryId)
        throw new Error('dsh-oauth-mcp-client: loader entry id is required');
    const reporter = registerConnection(ctx.root, resolved, entryId);
    ctx.effect(() => () => { reporter.dispose(); }, 'dsh-oauth-mcp-client.web-projection');
    ctx.inject(['systemPrompt'], (promptCtx) => {
        promptCtx.systemPrompt.section({
            name: `tool:mcp:${resolved.serverName}`,
            order: 118,
            text: mcpGuidance(resolved.serverName),
        });
    });
    const oauth = await createOAuthRuntime(ctx, resolved);
    ctx.effect(() => () => oauth.dispose(), 'dsh-oauth-mcp-client.oauth');
    const connection = startConnection(ctx, resolved, reconnect, oauth, reporter);
    ctx.effect(() => () => connection.dispose(), 'dsh-oauth-mcp-client.connection');
    if (resolved.failOnStartupError) {
        const outcome = await connection.ready;
        if (outcome.error !== undefined) {
            throw new Error(`dsh-oauth-mcp-client(${resolved.serverName}): initial authorization, connection, or tool synchronization failed`, { cause: outcome.error });
        }
    }
    else {
        void connection.ready.catch(() => {});
    }
}
//# sourceMappingURL=index.js.map
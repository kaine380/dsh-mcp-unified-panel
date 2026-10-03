/** Interactive OAuth runtime: loopback callback, browser hand-off, and state persistence. */
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { OAuthClientInformationFullSchema, OAuthClientInformationSchema, OAuthTokensSchema, } from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';
import { credentialRef } from './dsh.js';
const CALLBACK_PATH = '/oauth/callback';
const SUCCESS_HTML = '<!doctype html><meta charset="utf-8"><title>Authorized</title><p>Authorization complete. You may close this window.</p>';
const FAILURE_HTML = '<!doctype html><meta charset="utf-8"><title>Authorization failed</title><p>Authorization failed. Return to DeepSeek Harness for details.</p>';
const StoredOAuthStateSchema = z.object({
    version: z.literal(1),
    redirectUrl: z.string().optional(),
    clientInformation: z.union([OAuthClientInformationFullSchema, OAuthClientInformationSchema]).optional(),
    tokens: OAuthTokensSchema.optional(),
    discoveryState: z.object({ authorizationServerUrl: z.string() }).passthrough().optional(),
}).strict();
class CredentialOAuthStore {
    ctx;
    ref;
    tail = Promise.resolve();
    constructor(ctx, ref) {
        this.ctx = ctx;
        this.ref = ref;
    }
    async readRaw() {
        const resolved = await this.ctx.credentials.resolve(this.ref);
        if (!resolved)
            return { version: 1 };
        let parsed;
        try {
            parsed = JSON.parse(resolved.value);
        }
        catch {
            throw new Error(`dsh-oauth-mcp-client: credential ${this.ref} does not contain valid OAuth JSON`);
        }
        const result = StoredOAuthStateSchema.safeParse(parsed);
        if (!result.success) {
            throw new Error(`dsh-oauth-mcp-client: credential ${this.ref} contains unsupported OAuth state`);
        }
        return result.data;
    }
    async read() {
        await this.tail;
        return this.readRaw();
    }
    async update(mutator) {
        const run = this.tail.then(async () => {
            const state = await this.readRaw();
            mutator(state);
            await this.ctx.credentials.set(this.ref, JSON.stringify(state));
        });
        this.tail = run.catch(() => { });
        return run;
    }
}
class HarnessOAuthProvider {
    store;
    runtime;
    config;
    redirectUrl;
    verifier;
    expectedState;
    constructor(store, runtime, config, redirectUrl) {
        this.store = store;
        this.runtime = runtime;
        this.config = config;
        this.redirectUrl = redirectUrl;
    }
    get clientMetadata() {
        return {
            redirect_uris: [this.redirectUrl.toString()],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            client_name: `DeepSeek Harness MCP OAuth (${this.config.serverName})`,
            ...(this.config.scope === undefined ? {} : { scope: this.config.scope }),
        };
    }
    state() {
        this.expectedState = randomBytes(32).toString('base64url');
        return this.expectedState;
    }
    assertCallbackState(received) {
        if (!this.expectedState || received === null)
            throw new Error('OAuth callback state is missing');
        const expected = Buffer.from(this.expectedState);
        const actual = Buffer.from(received);
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
            throw new Error('OAuth callback state does not match');
        }
        this.expectedState = undefined;
    }
    async clientInformation() {
        const state = await this.store.read();
        return state.redirectUrl === this.redirectUrl.toString() ? state.clientInformation : undefined;
    }
    async saveClientInformation(clientInformation) {
        await this.store.update((state) => {
            state.redirectUrl = this.redirectUrl.toString();
            state.clientInformation = clientInformation;
        });
    }
    async tokens() {
        return (await this.store.read()).tokens;
    }
    async saveTokens(tokens) {
        await this.store.update((state) => { state.tokens = tokens; });
    }
    async redirectToAuthorization(authorizationUrl) {
        await this.runtime.beginAuthorization(authorizationUrl);
    }
    saveCodeVerifier(codeVerifier) {
        this.verifier = codeVerifier;
    }
    codeVerifier() {
        if (!this.verifier)
            throw new Error('dsh-oauth-mcp-client: OAuth code verifier is unavailable');
        return this.verifier;
    }
    async saveDiscoveryState(discoveryState) {
        await this.store.update((state) => { state.discoveryState = discoveryState; });
    }
    async discoveryState() {
        return (await this.store.read()).discoveryState;
    }
    async invalidateCredentials(scope) {
        if (scope === 'verifier') {
            this.verifier = undefined;
            return;
        }
        if (scope === 'all')
            this.verifier = undefined;
        await this.store.update((state) => {
            if (scope === 'all' || scope === 'client') {
                delete state.clientInformation;
                delete state.redirectUrl;
            }
            if (scope === 'all' || scope === 'tokens')
                delete state.tokens;
            if (scope === 'all' || scope === 'discovery')
                delete state.discoveryState;
        });
    }
}
class OAuthRuntimeImpl {
    ctx;
    config;
    server;
    openAuthorization;
    provider;
    finishAuth;
    pending;
    disposed = false;
    constructor(ctx, config, server, openAuthorization, redirectUrl) {
        this.ctx = ctx;
        this.config = config;
        this.server = server;
        this.openAuthorization = openAuthorization;
        const store = new CredentialOAuthStore(ctx, credentialRef(config.credentialRef));
        this.provider = new HarnessOAuthProvider(store, this, config, redirectUrl);
    }
    bindTransport(transport) {
        this.finishAuth = code => transport.finishAuth(code);
    }
    async beginAuthorization(authorizationUrl) {
        if (this.disposed)
            throw new Error('dsh-oauth-mcp-client: OAuth runtime is disposed');
        if (this.pending && !this.pending.settled)
            return;
        const gate = Promise.withResolvers();
        const pending = {
            promise: gate.promise,
            resolve: gate.resolve,
            reject: gate.reject,
            timer: setTimeout(() => {
                this.rejectPending(pending, new Error('dsh-oauth-mcp-client: browser authorization timed out'));
            }, this.config.authorizationTimeoutMs),
            settled: false,
        };
        pending.timer.unref();
        void pending.promise.catch(() => { });
        this.pending = pending;
        try {
            await this.openAuthorization(authorizationUrl);
            this.ctx.logger.info(`dsh-oauth-mcp-client(${this.config.serverName}): opened authorization in the default browser; waiting for the loopback callback`);
        }
        catch (error) {
            this.rejectPending(pending, new Error('dsh-oauth-mcp-client: failed to open the default browser', { cause: error }));
            throw error;
        }
    }
    async waitForAuthorization() {
        const pending = this.pending;
        if (!pending)
            throw new Error('dsh-oauth-mcp-client: authorization was requested without a pending browser flow');
        try {
            await pending.promise;
        }
        finally {
            if (this.pending === pending)
                this.pending = undefined;
        }
    }
    rejectPending(pending, error) {
        if (pending.settled)
            return;
        pending.settled = true;
        clearTimeout(pending.timer);
        pending.reject(error);
    }
    async handleCallback(request, response) {
        const url = new URL(request.url ?? '/', this.provider.redirectUrl);
        if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
            respond(response, 404, FAILURE_HTML);
            return;
        }
        const pending = this.pending;
        if (!pending || pending.settled) {
            respond(response, 409, FAILURE_HTML);
            return;
        }
        try {
            this.provider.assertCallbackState(url.searchParams.get('state'));
            const oauthError = url.searchParams.get('error');
            if (oauthError)
                throw new Error(`OAuth authorization was denied (${oauthError})`);
            const code = url.searchParams.get('code');
            if (!code)
                throw new Error('OAuth callback code is missing');
            if (!this.finishAuth)
                throw new Error('OAuth callback has no active MCP transport');
            await this.finishAuth(code);
            pending.settled = true;
            clearTimeout(pending.timer);
            pending.resolve();
            respond(response, 200, SUCCESS_HTML);
        }
        catch (error) {
            this.rejectPending(pending, error);
            respond(response, 400, FAILURE_HTML);
        }
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        const pending = this.pending;
        if (pending)
            this.rejectPending(pending, new Error('dsh-oauth-mcp-client: disposed during authorization'));
        this.server.closeAllConnections();
        await new Promise((resolve, reject) => {
            this.server.close(error => error ? reject(error) : resolve());
        });
    }
}
/** Start the loopback callback listener before the MCP SDK needs its redirect URI. */
export async function createOAuthRuntime(ctx, config, openAuthorization = openBrowser) {
    let runtime;
    const server = createServer((request, response) => {
        if (!runtime) {
            respond(response, 503, FAILURE_HTML);
            return;
        }
        void runtime.handleCallback(request, response).catch(() => {
            if (!response.headersSent)
                respond(response, 500, FAILURE_HTML);
            else
                response.destroy();
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.callbackPort, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address();
    const redirectUrl = new URL(`http://127.0.0.1:${String(address.port)}${CALLBACK_PATH}`);
    runtime = new OAuthRuntimeImpl(ctx, config, server, openAuthorization, redirectUrl);
    return runtime;
}
function respond(response, status, body) {
    response.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
    });
    response.end(body);
}
async function openBrowser(url) {
    const command = process.platform === 'darwin'
        ? { file: 'open', args: [url.toString()] }
        : process.platform === 'win32'
            ? { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url.toString()] }
            : { file: 'xdg-open', args: [url.toString()] };
    await new Promise((resolve, reject) => {
        const child = spawn(command.file, command.args, { stdio: 'ignore' });
        child.once('error', reject);
        child.once('close', code => code === 0
            ? resolve()
            : reject(new Error(`browser opener exited with code ${String(code)}`)));
    });
}
//# sourceMappingURL=oauth.js.map
/** OAuth-aware Streamable HTTP transport factory. */
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
/** Create a transport and bind its authorization-code exchange to the callback runtime. */
export function createTransport(config, oauth) {
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        authProvider: oauth.provider,
        requestInit: { headers: config.headers },
    });
    oauth.bindTransport(transport);
    return transport;
}
//# sourceMappingURL=transport.js.map
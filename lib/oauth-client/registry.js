/** Live Web-facing projection of OAuth MCP connections owned by this package. */
const registries = new WeakMap();
function registry(root) {
    let entries = registries.get(root);
    if (!entries) {
        entries = new Map();
        registries.set(root, entries);
    }
    return entries;
}
/** Register one configured connection in the root-owned Web projection. */
export function registerConnection(root, config, entryId) {
    const entries = registry(root);
    const view = {
        entryId,
        serverName: config.serverName,
        url: config.url,
        status: 'connecting',
        capabilities: [],
    };
    entries.set(config.serverName, view);
    return {
        setStatus(status, error) {
            view.status = status;
            if (error === undefined)
                delete view.error;
            else
                view.error = error instanceof Error ? error.message : String(error);
        },
        setCapabilities(capabilities) {
            view.capabilities = capabilities.map(capability => ({ ...capability }));
        },
        dispose() {
            if (entries.get(config.serverName) === view)
                entries.delete(config.serverName);
        },
    };
}
/** Return a detached snapshot of every live connection in stable name order. */
export function listConnections(root) {
    return [...registry(root).values()]
        .sort((left, right) => left.serverName < right.serverName ? -1 : left.serverName > right.serverName ? 1 : 0)
        .map(view => ({
        ...view,
        capabilities: view.capabilities.map(capability => ({ ...capability })),
    }));
}
//# sourceMappingURL=registry.js.map
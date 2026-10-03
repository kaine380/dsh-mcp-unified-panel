/**
 * dsh-mcp-unified-panel —— MCP 宿主服务（unifiedMcpManager）。
 */
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { MCP_PLUGIN_NAME, PANEL_MCP_BLOCK_BEGIN, PANEL_MCP_BLOCK_END, YAML_CUSTOM_TAGS, extractManagedRows, listMcpPatchRows, listOtherRows, mcpRowKind, readPatchFile, writeFileAtomic, validatePatchText, withPatchLock } from "../patch-editor.js";
import { SERVER_NAME_RE, applyServerEdit, describeSchemaError, inputFromPatchRow, mcpFeatureKind, patchRowToView, serverNameFromRowId, thirdPartyRowToView } from "./model.js";
import { mcpRemovePayloadSchema, mcpSavePayloadSchema, mcpSetEnabledPayloadSchema, mcpTestPayloadSchema, oauthAddPayloadSchema, oauthRemovePayloadSchema } from "./wire.js";
import { fiberPhaseOf, getLoaderEntry, mcpToolCount, waitForLoaderState } from "./status.js";
import { probeMcpServer } from "./probe.js";
function stripUndefined(value) {
    if (Array.isArray(value))
        return value.map((item) => stripUndefined(item));
    if (value !== null && typeof value === "object") {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (item === undefined)
                continue;
            out[key] = stripUndefined(item);
        }
        return out;
    }
    return value;
}
const MANAGED_ROW_IDS = new Set();
const FORK_ROW_ID_PREFIX = "unified-panel-mcp-";
const LEGACY_ROW_ID_PREFIX = "panel-mcp-";
function isManagedRow(row) {
    return typeof row.id === "string" && row.id.startsWith(FORK_ROW_ID_PREFIX);
}
function isLegacyPanelRow(row) {
    return typeof row.id === "string" && row.id.startsWith(LEGACY_ROW_ID_PREFIX);
}
/**
 * handler 内校验 payload：失败抛「字段：原因」的中文错误。
 * 网关边界的 codec 是宽松 schema（见 wire.ts），校验必须在这里做，
 * 否则失败会退化成宿主那句泛化的 `failed boundary validation`。
 */
function parseWirePayload(schema, raw, label) {
    const result = schema.safeParse(raw);
    if (result.success)
        return result.data;
    throw new Error(label + "：" + describeSchemaError(result.error));
}
/** JWT payload 解码（不验签，仅展示）：按序取 preferred_username/email/sub。 */
function decodeAccountFromTokens(tokens) {
    const out = {};
    try {
        const raw = tokens !== null && typeof tokens === "object" ? tokens.id_token ?? tokens.access_token : undefined;
        if (typeof raw !== "string")
            return out;
        const parts = raw.split(".");
        if (parts.length < 2 || typeof parts[1] !== "string")
            return out;
        const json = Buffer.from(parts[1].replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8");
        const payload = JSON.parse(json);
        if (payload !== null && typeof payload === "object") {
            if (typeof payload.preferred_username === "string")
                out.username = payload.preferred_username;
            if (typeof payload.email === "string")
                out.email = payload.email;
            if (out.username === undefined && typeof payload.sub === "string")
                out.username = payload.sub;
        }
    }
    catch {
        // 非 JWT 或解码失败：保持未知身份，不报错。
    }
    return out;
}
export class UnifiedMcpGateway extends TypertRemoteService {
    constructor(ctx) {
        super(ctx, "unifiedMcpManager");
    }
    get C() {
        return this.ctx;
    }
    patchPath() {
        const base = this.C.baseUrl;
        if (typeof base === "string" && base.length > 0) {
            try {
                const url = new URL(base);
                if (url.protocol === "file:")
                    return join(fileURLToPath(url), "cordis.patch.yml");
            }
            catch {
                // fall through to package-location fallback
            }
        }
        const packageDir = fileURLToPath(new URL("../../", import.meta.url));
        return join(resolve(packageDir, "../.."), "cordis.patch.yml");
    }
    async readRows() {
        const path = this.patchPath();
        const raw = await readPatchFile(path);
        const managed = extractManagedRows(raw);
        const allMcp = listMcpPatchRows(raw);
        const managedIds = new Set(managed.map((row) => row.id).filter((id) => typeof id === "string"));
        const external = allMcp.filter((row) => typeof row.id === "string" && !managedIds.has(row.id));
        const others = listOtherRows(raw).filter((row) => typeof row.id === "string" && !managedIds.has(row.id)).map((row) => ({ id: row.id, ...(typeof row.name === "string" ? { name: row.name } : {}) }));
        return { path, raw, managed, external, others };
    }
    decorate(row, managed, entry, enabled) {
        const view = patchRowToView(row);
        if (view === undefined)
            return undefined;
        if (!managed) {
            const kind = mcpFeatureKind(row);
            if (kind === "third-party" && typeof row.name === "string")
                view.clientName = row.name;
        }
        const fiberPhase = fiberPhaseOf(entry?.fiber?.state);
        return stripUndefined({
            ...view,
            enabled,
            managed,
            fiberPhase,
            toolCount: enabled ? mcpToolCount(this.C, view.serverName) : 0
        });
    }
    async list() {
        let patch = { path: this.patchPath(), ok: false, error: null };
        try {
            const { path, managed, external, others } = await this.readRows();
            patch = { path, ok: true, error: null };
            const servers = [];
            for (const row of managed) {
                const entry = typeof row.id === "string" ? getLoaderEntry(this.C, row.id) : undefined;
                const view = this.decorate(row, true, entry, row.disabled !== true);
                if (view !== undefined)
                    servers.push(view);
            }
            const externalServers = [];
            for (const row of external) {
                const entry = typeof row.id === "string" ? getLoaderEntry(this.C, row.id) : undefined;
                const kind = mcpFeatureKind(row);
                if (kind === "third-party") {
                    const view = thirdPartyRowToView(row);
                    if (view === undefined)
                        continue;
                    const fiberPhase = (await import("./status.js")).fiberPhaseOf(entry?.fiber?.state);
                    externalServers.push({
                        ...view,
                        managed: false,
                        kind: "third-party",
                        fiberPhase,
                        toolCount: view.enabled ? mcpToolCount(this.C, view.serverName) : 0,
                        oauth: this.oauthInfo(row),
                    });
                    continue;
                }
                const view = this.decorate(row, false, entry, row.disabled !== true);
                if (view !== undefined)
                    externalServers.push({ ...view, kind: "official-external" });
            }
            // 登录信息：第三方 OAuth 行的账号/过期时间（见 oauthInfo，缺失则降级）。
            const thirdParty = externalServers.filter((s) => s.kind === "third-party");
            void thirdParty;
            return { servers, externalServers, others, thirdParty, patch };
        }
        catch (error) {
            return { servers: [], externalServers: [], others: [], thirdParty: [], patch: { ...patch, error: error instanceof Error ? error.message : String(error) } };
        }
    }
    /** 第三方 OAuth 行的登录信息：账号用户名 + token 过期时间（拿不到则降级，不报错）。 */
    oauthInfo(row) {
        try {
            const config = row.config ?? {};
            const credentialRef = typeof config.credentialRef === "string" ? config.credentialRef : undefined;
            const info = {
                ...(credentialRef !== undefined ? { credentialRef, credentialRefPresent: true } : { credentialRefPresent: false }),
                login: this.credentialLoginInfo(credentialRef),
            };
            return info;
        }
        catch {
            return { credentialRefPresent: false, login: { state: "unknown" } };
        }
    }
    /** 读凭证库中的 OAuth JSON（同步快照不可用时降级）：只给用户名/过期时间存在性，不给密钥。 */
    credentialLoginInfo() {
        return { state: "unknown", note: "已登录信息需经 oauthStatus RPC 查询（面板按行懒加载）" };
    }
    findRowByServerName(rows, serverName) {
        return rows.find((row) => serverNameFromRowId(row.id) === serverName || (row.config?.serverName === serverName && isManagedRow(row)));
    }
    configInputFromRow(row) {
        return inputFromPatchRow(row);
    }
    async save(rawPayload) {
        const payload = parseWirePayload(mcpSavePayloadSchema, rawPayload, "MCP 配置无效");
        const input = payload.input;
        const previousName = payload.previousServerName ?? input.serverName;
        const { managed, external } = await this.readRows();
        // 官方外部行的原地编辑：先预检整行能无损通过官方 schema，不过则拒绝保存（一行都不写）。
        const extTarget = external.find((candidate) => candidate.config?.serverName === previousName && mcpFeatureKind(candidate) === "official");
        if (extTarget !== undefined && typeof extTarget.id === "string") {
            if (input.serverName !== previousName) {
                const clash = [...managed, ...external].find((candidate) => candidate !== extTarget && candidate.config?.serverName === input.serverName);
                if (clash !== undefined)
                    throw new Error('serverName "' + input.serverName + '" 已被占用（行 ' + String(clash.id) + "）");
            }
            let merged;
            try {
                merged = applyServerEdit(extTarget, input, extTarget.disabled !== true);
            }
            catch (error) {
                throw new Error("该行有面板不支持的字段，拒绝保存以防写坏：" + (error instanceof Error ? error.message : String(error)));
            }
            // 保持原 id/name/位置不动，只换 config（YAML 文档级原地写）。
            await this.replaceRowConfigBytePreserving(extTarget.id, merged.config);
            const reconciled = await waitForLoaderState(this.C, extTarget.id, (entry) => entry !== undefined);
            const entry = getLoaderEntry(this.C, extTarget.id);
            const server = this.decorate({ ...extTarget, config: merged.config }, false, entry, extTarget.disabled !== true);
            if (server === undefined)
                throw new Error("写入成功但生成的 MCP 行无效");
            return { server: { ...server, kind: "official-external" }, reconciled };
        }
        for (const row of external) {
            const name = row.config?.serverName;
            if (name === input.serverName)
                throw new Error('serverName "' + input.serverName + '" 已被 cordis.patch.yml 中的外部 MCP 行占用，请在文件中手动处理');
        }
        for (const row of managed) {
            const name = row.config?.serverName;
            if (name === input.serverName && serverNameFromRowId(row.id) !== previousName) {
                throw new Error('serverName "' + input.serverName + '" 已存在（受管行 ' + String(row.id) + "）");
            }
        }
        const previous = managed.find((row) => serverNameFromRowId(row.id) === previousName || row.config?.serverName === previousName);
        if (payload.previousServerName !== undefined && previous === undefined) {
            throw new Error('要编辑的 MCP 行不存在："' + previousName + '"');
        }
        const enabled = previous !== undefined ? previous.disabled !== true : payload.enabled;
        const nextRow = applyServerEdit(previous, input, enabled);
        const nextRows = managed.filter((row) => serverNameFromRowId(row.id) !== previousName && row.config?.serverName !== previousName);
        nextRows.push(nextRow);
        nextRows.sort((a, b) => String(a.config?.serverName ?? "").localeCompare(String(b.config?.serverName ?? "")));
        await writeManagedRows(this.patchPath(), nextRows);
        const reconciled = enabled
            ? await waitForLoaderState(this.C, nextRow.id, (entry) => entry !== undefined && entry.disabled !== true)
            : await waitForLoaderState(this.C, nextRow.id, (entry) => entry !== undefined && entry.disabled === true);
        const entry = getLoaderEntry(this.C, nextRow.id);
        const server = this.decorate(nextRow, true, entry, enabled);
        if (server === undefined)
            throw new Error("写入成功但生成的 MCP 行无效");
        return { server, reconciled };
    }
    async removeServer(rawPayload) {
        const payload = parseWirePayload(mcpRemovePayloadSchema, rawPayload, "删除参数无效");
        const { managed, external } = await this.readRows();
        const row = managed.find((candidate) => serverNameFromRowId(candidate.id) === payload.serverName || candidate.config?.serverName === payload.serverName);
        if (row !== undefined) {
            const nextRows = managed.filter((candidate) => candidate !== row);
            await writeManagedRows(this.patchPath(), nextRows);
            const reconciled = await waitForLoaderState(this.C, row.id, (entry) => entry === undefined);
            return { ok: true, reconciled };
        }
        // 官方外部行：原地删除整行（含可能存在的顶层 disabled 覆盖），绝不碰其它行。
        // 第三方行永远到不了这里：前端不给入口，调到了也明确拒绝。
        const ext = external.find((candidate) => candidate.config?.serverName === payload.serverName);
        if (ext !== undefined) {
            if (mcpFeatureKind(ext) === "third-party")
                throw new Error('"' + payload.serverName + '" 是第三方行：请用卡片上的卸载图标走 oauth-remove 删除');
            if (typeof ext.id !== "string")
                throw new Error('MCP 行 "' + payload.serverName + '" 没有可定位的 id，请在文件中手动删除');
            await this.removeRowByIdBytePreserving(ext.id);
            const reconciled = await waitForLoaderState(this.C, ext.id, (entry) => entry === undefined);
            return { ok: true, reconciled };
        }
        throw new Error('MCP 行 "' + payload.serverName + '" 不存在');
    }
    /** 按 entryId 删除整行（insert 行内 + 顶层覆盖），其它字节原样保留。 */
    async removeRowByIdBytePreserving(entryId) {
        const path = this.patchPath();
        return withPatchLock(path, async () => {
            const { parseDocument, isMap, isSeq } = await import("yaml");
            const raw = await readPatchFile(path);
            const doc = parseDocument(raw);
            if (doc.errors.length > 0)
                throw new Error("cordis.patch.yml 解析失败：" + String(doc.errors[0]?.message ?? doc.errors[0]));
            if (!isSeq(doc.contents))
                throw new Error("cordis.patch.yml 顶层必须是 YAML 数组");
            let found = false;
            for (let i = doc.contents.items.length - 1; i >= 0; i--) {
                const item = doc.contents.items[i];
                if (!isMap(item))
                    continue;
                const insert = item.get("insert", true);
                if (isSeq(insert)) {
                    for (let j = insert.items.length - 1; j >= 0; j--) {
                        const rowNode = insert.items[j];
                        if (isMap(rowNode) && rowNode.get("id") === entryId) {
                            insert.items.splice(j, 1);
                            found = true;
                        }
                    }
                    if (insert.items.length === 0)
                        doc.contents.items.splice(i, 1);
                    continue;
                }
                if (item.get("id") === entryId) {
                    doc.contents.items.splice(i, 1);
                    found = true;
                }
            }
            if (!found)
                throw new Error('MCP 行 "' + entryId + '" 不存在');
            const next = String(doc);
            await validatePatchText(next);
            await writeFileAtomic(path, next);
            try {
                const { chmod } = await import("node:fs/promises");
                await chmod(path, 0o600);
            }
            catch {
                // 非 POSIX 平台忽略。
            }
        });
    }
    async setEnabled(rawPayload) {
        const payload = parseWirePayload(mcpSetEnabledPayloadSchema, rawPayload, "启用参数无效");
        const { managed, external } = await this.readRows();
        // 先看官方受管行（含 legacy panel-mcp-* 行：它们同样由官方客户端实现，
        // 必须走官方 schema 路径，绝不能掉进第三方字节保留分支）。
        const official = managed.find((candidate) => serverNameFromRowId(candidate.id) === payload.serverName || candidate.config?.serverName === payload.serverName)
            ?? external.find((candidate) => mcpFeatureKind(candidate) === "official" && (candidate.config?.serverName === payload.serverName || serverNameFromRowId(candidate.id) === payload.serverName));
        if (official !== undefined && typeof official.id === "string") {
            const targetId = official.id;
            const isManaged = managed.some((candidate) => candidate.id === targetId);
            // 官方受管块内的行走受管写；块外的官方行（legacy）走字节保留但保持官方 view。
            if (isManaged) {
                const row = managed.find((candidate) => candidate.id === targetId);
                row.disabled = !payload.enabled;
                await writeManagedRows(this.patchPath(), managed);
            }
            else {
                await this.setRowDisabledBytePreserving(targetId, payload.enabled);
            }
            const reconciled = payload.enabled
                ? await waitForLoaderState(this.C, targetId, (entry) => entry !== undefined && entry.disabled !== true)
                : await waitForLoaderState(this.C, targetId, (entry) => entry !== undefined && entry.disabled === true);
            const entry = getLoaderEntry(this.C, targetId);
            const server = this.decorate({ ...official, disabled: payload.enabled ? undefined : true }, isManaged, entry, payload.enabled);
            if (server === undefined)
                throw new Error("写入成功但生成的 MCP 行无效");
            return { server: { ...server, kind: "official-external" }, reconciled };
        }
        const third = external.find((candidate) => candidate.config?.serverName === payload.serverName);
        if (third !== undefined && mcpFeatureKind(third) === "third-party" && typeof third.id === "string") {
            // 第三方行只翻自身 disabled 布尔，字节保留写（绝不重写 name/credentialRef/secret）。
            const reconciledThird = await this.setRowDisabledBytePreserving(third.id, payload.enabled);
            const entry = getLoaderEntry(this.C, third.id);
            const view = thirdPartyRowToView({ ...third, disabled: payload.enabled ? undefined : true });
            const fiberPhase = (await import("./status.js")).fiberPhaseOf(entry?.fiber?.state);
            return { server: { ...view, managed: false, kind: "third-party", fiberPhase, toolCount: payload.enabled ? mcpToolCount(this.C, view.serverName) : 0, oauth: this.oauthInfo(third) }, reconciled: reconciledThird };
        }
        const row = managed.find((candidate) => serverNameFromRowId(candidate.id) === payload.serverName || candidate.config?.serverName === payload.serverName);
        if (row === undefined)
            throw new Error('MCP 行 "' + payload.serverName + '" 不存在（受管行、官方外部行、第三方行均未命中）');
        row.disabled = !payload.enabled;
        await writeManagedRows(this.patchPath(), managed);
        const reconciled = payload.enabled
            ? await waitForLoaderState(this.C, row.id, (entry) => entry !== undefined && entry.disabled !== true)
            : await waitForLoaderState(this.C, row.id, (entry) => entry !== undefined && entry.disabled === true);
        const entry = getLoaderEntry(this.C, row.id);
        const server = this.decorate(row, true, entry, payload.enabled);
        if (server === undefined)
            throw new Error("写入成功但生成的 MCP 行无效");
        return { server, reconciled };
    }
    /** 按 entryId 原地替换整行 config（保持 id/name/位置不动，!!js 原样往返）。 */
    async replaceRowConfigBytePreserving(entryId, config) {
        const path = this.patchPath();
        return withPatchLock(path, async () => {
            const { parseDocument, isMap, isSeq } = await import("yaml");
            const { stringify } = await import("yaml");
            const raw = await readPatchFile(path);
            const doc = parseDocument(raw, { customTags: YAML_CUSTOM_TAGS });
            if (doc.errors.length > 0)
                throw new Error("cordis.patch.yml 解析失败：" + String(doc.errors[0]?.message ?? doc.errors[0]));
            if (!isSeq(doc.contents))
                throw new Error("cordis.patch.yml 顶层必须是 YAML 数组");
            let found = false;
            for (const item of doc.contents.items) {
                if (!isMap(item))
                    continue;
                const insert = item.get("insert", true);
                if (!isSeq(insert))
                    continue;
                for (const rowNode of insert.items) {
                    if (!isMap(rowNode) || rowNode.get("id") !== entryId)
                        continue;
                    found = true;
                    rowNode.set("config", doc.createNode(config, { customTags: YAML_CUSTOM_TAGS }));
                }
            }
            if (!found)
                throw new Error('MCP 行 "' + entryId + '" 不存在');
            void stringify;
            const next = String(doc);
            await validatePatchText(next);
            await writeFileAtomic(path, next);
            try {
                const { chmod } = await import("node:fs/promises");
                await chmod(path, 0o600);
            }
            catch {
                // 非 POSIX 平台忽略。
            }
        });
    }
    /** 第三方行只翻 disabled 的字节保留写（YAML 文档级编辑，不触碰其它键）。 */
    async setRowDisabledBytePreserving(entryId, enabled) {
        const path = this.patchPath();
        return withPatchLock(path, async () => {
            const { parseDocument, isMap, isSeq } = await import("yaml");
            const raw = await readPatchFile(path);
            const doc = parseDocument(raw);
            if (doc.errors.length > 0)
                throw new Error("cordis.patch.yml 解析失败：" + String(doc.errors[0]?.message ?? doc.errors[0]));
            let found = false;
            // 顶层 `- id: X` 覆盖行优先于 insert 行内 disabled（loader 按 id 合并时覆盖行胜出），
            // 所以启停必须同时处理两处：disable 在两处写 disabled: true；enable 删除行内 disabled
            // 并移除整个顶层覆盖条目（dsh-plugin-manager toggleMcp 同款语义）。
            const contents = doc.contents;
            if (isSeq(contents)) {
                for (const item of contents.items) {
                    if (!isMap(item))
                        continue;
                    const insert = item.get("insert", true);
                    if (isSeq(insert)) {
                        for (const rowNode of insert.items) {
                            if (isMap(rowNode) && rowNode.get("id") === entryId) {
                                found = true;
                                if (enabled)
                                    rowNode.delete("disabled");
                                else
                                    rowNode.set("disabled", true);
                            }
                        }
                    }
                }
            }
            if (isSeq(contents)) {
                for (let i = contents.items.length - 1; i >= 0; i--) {
                    const item = contents.items[i];
                    if (!isMap(item) || item.get("id") !== entryId)
                        continue;
                    const insert = item.get("insert", true);
                    if (isSeq(insert))
                        continue;
                    found = true;
                    if (enabled)
                        contents.items.splice(i, 1);
                    else
                        item.set("disabled", true);
                }
            }
            if (!found)
                throw new Error('MCP 行 "' + entryId + '" 不存在');
            const { stringify } = await import("node:util").catch(() => ({}));
            void stringify;
            const next = String(doc);
            await validatePatchText(next);
            await writeFileAtomic(path, next);
            try {
                const { chmod } = await import("node:fs/promises");
                await chmod(path, 0o600);
            }
            catch {
                // 非 POSIX 平台忽略。
            }
        }).then(async () => {
            return enabled
                ? await waitForLoaderState(this.C, entryId, (entry) => entry !== undefined && entry.disabled !== true)
                : await waitForLoaderState(this.C, entryId, (entry) => entry !== undefined && entry.disabled === true);
        });
    }
    async test(rawPayload) {
        const payload = parseWirePayload(mcpTestPayloadSchema, rawPayload, "测试参数无效");
        if (payload !== null && typeof payload === "object" && !("transport" in payload) && "serverName" in payload) {
            const { managed, external } = await this.readRows();
            const row = [...managed, ...external].find((candidate) => candidate.config?.serverName === payload.serverName || serverNameFromRowId(candidate.id) === payload.serverName);
            if (row === undefined)
                throw new Error('MCP 行 "' + String(payload.serverName) + '" 不存在');
            if (mcpFeatureKind(row) === "third-party") {
                const sName = String(payload.serverName);
                if (row.disabled === true) {
                    return { ok: false, tools: [], error: "该服务已停用，请开启右下角开关以连接" };
                }
                const entry = typeof row.id === "string" ? getLoaderEntry(this.C, row.id) : undefined;
                const phase = (await import("./status.js")).fiberPhaseOf(entry?.fiber?.state);
                const prefix = `mcp__${sName}__`;
                const schemas = this.C.tools?.schemas ? this.C.tools.schemas() : [];
                const liveTools = Array.isArray(schemas)
                    ? schemas
                        .filter((s) => typeof s?.name === "string" && s.name.startsWith(prefix))
                        .map((s) => ({
                            name: s.name.slice(prefix.length),
                            ...(s.description ? { description: s.description } : {})
                        }))
                    : [];
                if (liveTools.length > 0) {
                    return { ok: true, tools: liveTools };
                }
                if (phase === "failed") {
                    return { ok: false, tools: [], error: "连接或授权失败（fiber=failed），请检查网络或重新授权" };
                }
                if (phase === "loading" || phase === "pending") {
                    return { ok: true, tools: [], note: "服务连接或握手中（fiber=" + String(phase) + "），请稍候重试" };
                }
                return { ok: false, tools: [], error: "未发现激活的工具（fiber=" + String(phase ?? "unknown") + "），请检查服务状态" };
            }
            return probeMcpServer(this.configInputFromRow(row));
        }
        return probeMcpServer(payload);
    }
    /** 新增 OAuth 连接：落盘 insert 行（含 credentialRef），HMR 热加载后触发浏览器授权登录。 */
    async oauthAdd(rawPayload) {
        const parsed = oauthAddPayloadSchema.safeParse(rawPayload);
        if (!parsed.success)
            throw new Error("OAuth 参数无效：" + describeSchemaError(parsed.error));
        const { serverName, url } = parsed.data;
        if (!SERVER_NAME_RE.test(serverName))
            throw new Error("serverName 只能包含 1-32 位字母、数字、下划线或连字符");
        let target;
        try {
            target = new URL(url);
        }
        catch {
            throw new Error("url 必须是合法 URL");
        }
        if (target.protocol !== "https:" && target.hostname !== "127.0.0.1" && target.hostname !== "localhost")
            throw new Error("url 必须使用 HTTPS（本地回环 http 除外）");
        const { managed, external } = await this.readRows();
        const clash = [...managed, ...external].find((row) => row.config?.serverName === serverName);
        if (clash !== undefined)
            throw new Error('serverName "' + serverName + '" 已存在（行 ' + String(clash.id) + "），请换名或先删除");
        const credentialRef = "DSH_MCP_OAUTH_" + serverName.toUpperCase().replaceAll("-", "_");
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialRef))
            throw new Error("serverName 无法派生合法 credentialRef");
        const entryId = "oauth-mcp-" + serverName;
        const { raw } = await this.readRows();
        const { parseDocument, isSeq } = await import("yaml");
        const doc = parseDocument(raw);
        if (doc.errors.length > 0)
            throw new Error("cordis.patch.yml 解析失败");
        if (!isSeq(doc.contents))
            throw new Error("cordis.patch.yml 顶层必须是 YAML 数组");
        doc.add({
            insert: [{
                    id: entryId,
                    name: "dsh-mcp-unified-panel/oauth-client",
                    config: {
                        serverName,
                        url: target.toString(),
                        credentialRef,
                        failOnStartupError: false,
                        authorizationTimeoutMs: 300000,
                        toolCallTimeoutMs: 120000,
                        reconnect: { enabled: true },
                    },
                }],
        });
        const path = this.patchPath();
        await withPatchLock(path, async () => {
            const next = String(doc);
            await validatePatchText(next);
            await writeFileAtomic(path, next);
            try {
                const { chmod } = await import("node:fs/promises");
                await chmod(path, 0o600);
            }
            catch {
                // 非 POSIX 平台忽略。
            }
        });
        const reconciled = await waitForLoaderState(this.C, entryId, (entry) => entry !== undefined);
        return { added: serverName, entryId, credentialRef, reconciled };
    }
    /** 移除 OAuth 连接：删除 insert 行（找不到 insert 行则永久禁用该 id）。 */
    async oauthRemove(rawPayload) {
        const parsed = oauthRemovePayloadSchema.safeParse(rawPayload);
        if (!parsed.success)
            throw new Error("OAuth 参数无效：" + describeSchemaError(parsed.error));
        const { serverName } = parsed.data;
        const { raw } = await this.readRows();
        const { parseDocument, isMap, isSeq } = await import("yaml");
        const doc = parseDocument(raw);
        if (doc.errors.length > 0)
            throw new Error("cordis.patch.yml 解析失败");
        if (!isSeq(doc.contents))
            throw new Error("cordis.patch.yml 顶层必须是 YAML 数组");
        let entryId;
        for (let patchIndex = 0; patchIndex < doc.contents.items.length; patchIndex++) {
            const patch = doc.contents.items[patchIndex];
            if (!isMap(patch))
                continue;
            const insert = patch.get("insert", true);
            if (!isSeq(insert))
                continue;
            const rowIndex = insert.items.findIndex((row) => {
                if (!isMap(row))
                    return false;
                if (row.get("id") === "oauth-mcp-" + serverName)
                    return true;
                const config = row.get("config", true);
                return isMap(config) && config.get("serverName") === serverName && row.get("id") !== undefined && String(row.get("id")).startsWith("oauth-mcp-");
            });
            if (rowIndex < 0)
                continue;
            const rowNode = insert.items[rowIndex];
            entryId = isMap(rowNode) ? String(rowNode.get("id")) : "oauth-mcp-" + serverName;
            insert.items.splice(rowIndex, 1);
            if (insert.items.length === 0)
                doc.contents.items.splice(patchIndex, 1);
            const path = this.patchPath();
            await withPatchLock(path, async () => {
                const next = String(doc);
                await validatePatchText(next);
                await writeFileAtomic(path, next);
                try {
                    const { chmod } = await import("node:fs/promises");
                    await chmod(path, 0o600);
                }
                catch {
                    // 非 POSIX 平台忽略。
                }
            });
            const reconciled = await waitForLoaderState(this.C, entryId, (entry) => entry === undefined);
            return { removed: serverName, reconciled };
        }
        entryId = "oauth-mcp-" + serverName;
        const path = this.patchPath();
        await withPatchLock(path, async () => {
            const raw2 = await readPatchFile(path);
            const doc2 = parseDocument(raw2);
            if (!isSeq(doc2.contents))
                throw new Error("cordis.patch.yml 顶层必须是 YAML 数组");
            doc2.add({ id: entryId, disabled: true });
            const next = String(doc2);
            await validatePatchText(next);
            await writeFileAtomic(path, next);
        });
        return { removed: serverName, reconciled: false, disabledOnly: true };
    }
    /** 第三方 OAuth 行登录信息：账号用户名 + token 过期时间（凭证库），拿不到则降级。 */
    async oauthStatus(rawPayload) {
        const name = rawPayload !== null && typeof rawPayload === "object" ? rawPayload.serverName : undefined;
        if (typeof name !== "string" || name === "")
            throw new Error("OAuth 参数无效：serverName 必须是字符串");
        const { external } = await this.readRows();
        const row = external.find((candidate) => candidate.config?.serverName === name);
        if (row === undefined || mcpFeatureKind(row) !== "third-party")
            throw new Error('第三方 OAuth 行 "' + name + '" 不存在');
        const config = row.config ?? {};
        const ref = typeof config.credentialRef === "string" ? config.credentialRef : undefined;
        const login = await this.readOAuthLogin(ref);
        return {
            serverName: name,
            ...(typeof row.id === "string" ? { entryId: row.id } : {}),
            ...(ref !== undefined ? { credentialRef: ref } : {}),
            credentialRefPresent: ref !== undefined,
            login,
        };
    }
    /** 读凭证库 OAuth JSON，只回传展示字段（用户名/过期时间存在性），不回传密钥。 */
    async readOAuthLogin(ref) {
        if (typeof ref !== "string" || ref === "")
            return { state: "no-credential", note: "该行未配置 credentialRef" };
        try {
            const creds = this.C.credentials;
            if (creds === undefined || typeof creds.resolve !== "function")
                return { state: "unknown", note: "凭证服务不可用" };
            const resolved = await creds.resolve(ref);
            if (resolved === undefined || resolved === null)
                return { state: "not-authorized", note: "尚未授权：行挂载后将在浏览器中完成登录" };
            let parsed;
            try {
                parsed = JSON.parse(resolved.value);
            }
            catch {
                return { state: "unknown", note: "凭证不是合法 OAuth JSON" };
            }
            const tokens = parsed !== null && typeof parsed === "object" ? parsed.tokens : undefined;
            const account = decodeAccountFromTokens(tokens);
            const out = { state: tokens ? "authorized" : "not-authorized" };
            if (account.username !== undefined)
                out.username = account.username;
            if (account.email !== undefined)
                out.email = account.email;
            if (tokens !== null && typeof tokens === "object" && typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)) {
                out.expiresInSeconds = tokens.expires_in;
                out.note = "token 相对有效期 " + String(tokens.expires_in) + "s（绝对过期时间需结合授权时刻换算）";
            }
            if (tokens !== null && typeof tokens === "object" && typeof tokens.scope === "string" && tokens.scope !== "")
                out.scopes = String(tokens.scope).split(/\s+/).filter(Boolean);
            if (out.username === undefined && out.email === undefined)
                out.note = (out.note !== undefined ? out.note + "；" : "") + "已登录（身份未知）";
            return out;
        }
        catch (error) {
            return { state: "unknown", note: "读取登录信息失败：" + (error instanceof Error ? error.message : String(error)) };
        }
    }
    /** 已装插件包清单（只读，替代 dsh-plugin-manager 的 plugins 页；改动走 dsh plugin CLI）。 */
    async plugins() {
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        let dir = null;
        try {
            const base = this.C.baseUrl;
            if (typeof base === "string" && base.startsWith("file:")) {
                const { fileURLToPath } = await import("node:url");
                dir = fileURLToPath(new URL(base));
            }
        }
        catch { dir = null; }
        if (dir === null) {
            const { fileURLToPath } = await import("node:url");
            dir = join(fileURLToPath(new URL("../../", import.meta.url)), "../..");
        }
        const out = [];
        try {
            const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
            const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
            for (const name of Object.keys(deps).sort()) {
                let version = deps[name] ?? "";
                let desc = "";
                try {
                    const dep = JSON.parse(await readFile(join(dir, "node_modules", name, "package.json"), "utf8"));
                    if (dep.version) version = dep.version;
                    if (dep.description) desc = dep.description;
                }
                catch { }
                out.push({ name, version, desc: desc.length > 110 ? desc.slice(0, 110) + "…" : desc });
            }
        }
        catch (error) {
            throw new Error("读取插件清单失败：" + (error instanceof Error ? error.message : String(error)));
        }
        return { plugins: out };
    }
    reload() {
        return this.list();
    }
}
// 供 CLI 复用：判断一个 patch 行是否由面板管理。
export { MANAGED_ROW_IDS, isManagedRow, isLegacyPanelRow, FORK_ROW_ID_PREFIX, LEGACY_ROW_ID_PREFIX, MCP_PLUGIN_NAME };

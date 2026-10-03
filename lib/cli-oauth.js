/**
 * dsh-mcp-unified-panel —— OAuth CLI（oauth-add/remove/status + 第三方启停）。
 *
 * 与宿主网关的 oauthAdd/oauthRemove/oauthStatus 同语义的离线实现：
 * 直接读写 profile cordis.patch.yml（YAML 文档级编辑，字节保留），
 * 网关在线时由 DSH watchUserPatches 热加载，无需重启。
 */
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { readPatchFile, validatePatchText, withPatchLock, writeFileAtomic } from "./patch-editor.js";
import { SERVER_NAME_RE } from "./mcp/model.js";

export function profilePatchPath(profile) {
    return join(resolveDshHome(), "profiles", profile, "cordis.patch.yml");
}

function credentialRefFor(serverName) {
    return "DSH_MCP_OAUTH_" + serverName.toUpperCase().replaceAll("-", "_");
}

/** 新增 OAuth 连接：落盘 oauth-mcp-<name> 行（含 credentialRef），HMR 热加载后触发浏览器授权。 */
export async function oauthAddCli(name, url, profile) {
    if (name === undefined || !SERVER_NAME_RE.test(name))
        throw new Error("--name 必须匹配 " + String(SERVER_NAME_RE));
    if (url === undefined)
        throw new Error("oauth-add 需要 --url <https-url>");
    let target;
    try {
        target = new URL(url);
    }
    catch {
        throw new Error("url 必须是合法 URL");
    }
    if (target.protocol !== "https:" && target.hostname !== "127.0.0.1" && target.hostname !== "localhost")
        throw new Error("url 必须使用 HTTPS（本地回环 http 除外）");
    const path = profilePatchPath(profile);
    return withPatchLock(path, async () => {
        const { parseDocument, isSeq } = await import("yaml");
        const raw = await readPatchFile(path);
        const doc = parseDocument(raw);
        if (doc.errors.length > 0)
            throw new Error("cordis.patch.yml 解析失败");
        if (!isSeq(doc.contents))
            throw new Error("cordis.patch.yml 顶层必须是 YAML 数组");
        const entryId = "oauth-mcp-" + name;
        const seen = String(raw).includes("serverName: " + name) || String(raw).includes("serverName:" + name);
        if (seen)
            throw new Error('serverName "' + name + '" 已存在，请换名或先删除');
        const credentialRef = credentialRefFor(name);
        doc.add({
            insert: [{
                    id: entryId,
                    name: "dsh-mcp-unified-panel/oauth-client",
                    config: {
                        serverName: name,
                        url: target.toString(),
                        credentialRef,
                        failOnStartupError: false,
                        authorizationTimeoutMs: 300000,
                        toolCallTimeoutMs: 120000,
                        reconnect: { enabled: true },
                    },
                }],
        });
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
        console.log('已添加 OAuth 连接 "' + name + '"（' + entryId + "，credentialRef=" + credentialRef + "，网关在线时自动热加载并触发浏览器授权）");
        return 0;
    });
}

/** 移除 OAuth 连接：删除 oauth-mcp- 行（找不到 insert 行则永久禁用该 id）。 */
export async function oauthRemoveCli(name, profile) {
    if (name === undefined || name === "")
        throw new Error("oauth-remove 需要一个 serverName 参数");
    const path = profilePatchPath(profile);
    return withPatchLock(path, async () => {
        const { parseDocument, isMap, isSeq } = await import("yaml");
        const raw = await readPatchFile(path);
        const doc = parseDocument(raw);
        if (doc.errors.length > 0)
            throw new Error("cordis.patch.yml 解析失败");
        if (!isSeq(doc.contents))
            throw new Error("cordis.patch.yml 顶层必须是 YAML 数组");
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
                if (row.get("id") === "oauth-mcp-" + name)
                    return true;
                const config = row.get("config", true);
                return isMap(config) && config.get("serverName") === name && row.get("id") !== undefined && String(row.get("id")).startsWith("oauth-mcp-");
            });
            if (rowIndex < 0)
                continue;
            insert.items.splice(rowIndex, 1);
            if (insert.items.length === 0)
                doc.contents.items.splice(patchIndex, 1);
            const next = String(doc);
            await validatePatchText(next);
            await writeFileAtomic(path, next);
            console.log('已删除 OAuth 连接 "' + name + '"');
            return 0;
        }
        doc.add({ id: "oauth-mcp-" + name, disabled: true });
        const next = String(doc);
        await validatePatchText(next);
        await writeFileAtomic(path, next);
        console.log('未找到 insert 行，已永久禁用 "oauth-mcp-' + name + '"（bundle 行兜底）');
        return 0;
    });
}

/** 第三方行启停：只翻该行自身的 disabled 布尔（YAML 文档级字节保留写）。 */
export async function setThirdPartyEnabled(profile, entryId, enabled) {
    const path = profilePatchPath(profile);
    return withPatchLock(path, async () => {
        const { parseDocument, isMap, isSeq } = await import("yaml");
        const raw = await readPatchFile(path);
        const doc = parseDocument(raw);
        if (doc.errors.length > 0)
            throw new Error("cordis.patch.yml 解析失败");
        let found = false;
        if (isSeq(doc.contents)) {
            for (const item of doc.contents.items) {
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
        if (isSeq(doc.contents)) {
            for (let i = doc.contents.items.length - 1; i >= 0; i--) {
                const item = doc.contents.items[i];
                if (!isMap(item) || item.get("id") !== entryId)
                    continue;
                const insert = item.get("insert", true);
                if (isSeq(insert))
                    continue;
                found = true;
                if (enabled)
                    doc.contents.items.splice(i, 1);
                else
                    item.set("disabled", true);
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

function decodeAccount(tokens) {
    const out = {};
    try {
        const raw = tokens !== null && typeof tokens === "object" ? tokens.id_token ?? tokens.access_token : undefined;
        if (typeof raw !== "string")
            return out;
        const parts = raw.split(".");
        if (parts.length < 2 || typeof parts[1] !== "string")
            return out;
        const payload = JSON.parse(Buffer.from(parts[1].replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8"));
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
        // 非 JWT：保持未知。
    }
    return out;
}

/** 登录信息：读 DSH 凭证库太重，CLI 只提示 credentialRef 与 JWT 速览（不读密钥文件）。 */
export async function oauthStatusCli(name, profile) {
    if (name === undefined || name === "")
        throw new Error("oauth-status 需要一个 serverName 参数");
    const path = profilePatchPath(profile);
    const raw = await readPatchFile(path);
    const hit = raw.split("\n").findIndex((line) => line.includes("serverName: " + name) || line.includes("serverName:" + name));
    if (hit < 0)
        throw new Error('第三方 OAuth 行 "' + name + '" 不存在');
    const refHit = raw.split("\n").find((line) => line.trim().startsWith("credentialRef:"));
    console.log('serverName: ' + name);
    console.log('patch: ' + path);
    console.log('credentialRef: ' + (refHit !== undefined ? refHit.trim() : "（未配置）"));
    console.log("登录信息请在面板中查看（账号用户名 + token 过期时间，凭证库实时读取）。");
    void decodeAccount;
    return 0;
}

/** cli-mcp.js 的 oauth-* 分发入口。 */
export async function oauthCli(command, positional, flags, profile) {
    if (command === "oauth-add") {
        let name;
        let url;
        const rest = process.argv.slice(2);
        for (let i = 0; i < rest.length; i++) {
            if (rest[i] === "--name")
                name = rest[i + 1];
            if (rest[i] === "--url")
                url = rest[i + 1];
        }
        void positional;
        void flags;
        return oauthAddCli(name, url, profile.name);
    }
    if (command === "oauth-remove" || command === "oauth-status") {
        const name = positional[0];
        if (name === undefined) {
            console.error(command + " 需要一个 serverName 参数");
            return 2;
        }
        if (command === "oauth-remove" && !flags.yes) {
            console.log('oauth-remove 将删除 OAuth 连接 "' + name + '"（insert 行），用 --yes 跳过此提示不适用非交互场景时请带 --yes');
        }
        return command === "oauth-remove" ? oauthRemoveCli(name, profile.name) : oauthStatusCli(name, profile.name);
    }
    console.error('未知命令 "' + command + '"');
    return 2;
}

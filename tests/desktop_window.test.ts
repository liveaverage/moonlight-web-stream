import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { SessionStartup, SessionStartupTimeout } from "../web/session_startup.ts"

const source = ts.transpileModule(readFileSync(new URL("../web/desktop_window.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const origin = "https://example.test"
const type = "moonlight-viewer-startup"

function fixture(onNavigate: (f: any) => void = f => { f.send("booting"); f.send("ready") }) {
    const window = Object.assign(new EventTarget(), { location: { origin, href: origin + "/", search: "" }, opener: null as any })
    let href = "about:blank", id = 0, navigations = 0, grants = 0, reloads = 0
    const target = {
        closed: false,
        document: { readyState: "loading" },
        location: {
            get href() { return href },
            set href(value: string) { href = value; navigations++; queueMicrotask(() => onNavigate(f)) },
        },
        postMessage(data: any) { if (data.state === "start") grants++ },
    }
    const send = (state: string, extra: Record<string, any> = {}) => {
        const message = Object.assign(new Event("message"), {
            source: target, origin, data: { type, loadId: new URL(href).searchParams.get("loadId"), state }, ...extra,
        })
        window.dispatchEvent(message)
    }
    const exports: any = {}
    runInNewContext(source, { exports, window, URL, URLSearchParams, crypto: { randomUUID: () => String(++id) } })
    const f = { window, target, send, exports, get navigations() { return navigations }, get grants() { return grants }, get reloads() { return reloads },
        open: (budget = 500) => exports.openDesktopWindow(target, origin + "/stream.html?connectBy=unchanged", new SessionStartup(Date.now() + budget, 1), async () => { reloads++ }),
    }
    return f
}

test("a loaded viewer receives one start grant and keeps the shared deadline", async () => {
    const f = fixture()
    assert.equal(await f.open(), true)
    assert.equal(f.navigations, 1)
    assert.equal(f.grants, 1)
    assert.equal(new URL(f.target.location.href).searchParams.get("connectBy"), "unchanged")
})

test("a slow healthy bootstrap is not reloaded", async () => {
    const f = fixture(f => { f.send("booting"); setTimeout(() => f.send("ready"), 25) })
    assert.equal(await f.open(), true)
    assert.equal(f.navigations, 1)
})

test("a browser error document is retried before any stream can start", async () => {
    const f = fixture(f => {
        if (f.navigations === 1) {
            Object.defineProperty(f.target, "document", { configurable: true, get() { throw new Error("isolated error document") } })
        } else { f.send("booting"); f.send("ready") }
    })
    assert.equal(await f.open(), true)
    assert.equal(f.reloads, 1)
    assert.equal(f.navigations, 2)
    assert.equal(f.grants, 1)
})

test("a failed script load is retried and stale bootstrap messages cannot start a stream", async () => {
    const f = fixture(f => {
        if (f.navigations === 1) f.target.document.readyState = "complete"
        else {
            f.send("ready", { data: { type, loadId: "1", state: "ready" } })
            f.send("ready", { source: {} })
            f.send("ready", { origin: "https://other.test" })
            assert.equal(f.grants, 0)
            f.send("booting"); f.send("ready")
        }
    })
    assert.equal(await f.open(), true)
    assert.equal(f.grants, 1)
})

test("transient bootstrap failures request a fresh readiness check", async () => {
    const f = fixture(f => {
        f.send("booting")
        f.send(f.navigations === 1 ? "retry" : "ready")
    })
    assert.equal(await f.open(), true)
    assert.equal(f.reloads, 1)
    assert.equal(f.grants, 1)
})

test("permanent bootstrap failures do not receive a launch grant", async () => {
    const f = fixture(f => { f.send("booting"); f.send("failed") })
    await assert.rejects(f.open(), /could not initialize/)
    assert.equal(f.grants, 0)
})

test("closing a connection window ends its readiness loop", async () => {
    const f = fixture(f => { f.target.closed = true })
    assert.equal(await f.open(), false)
    assert.equal(f.grants, 0)
})

test("page recovery uses the same deadline", async () => {
    const f = fixture(f => { f.target.document.readyState = "complete" })
    await assert.rejects(f.open(20), SessionStartupTimeout)
    assert.equal(f.grants, 0)
})

test("the viewer waits for the matching parent grant before continuing", async () => {
    const f = fixture()
    const sent: string[] = []
    f.window.location.search = "?loadId=child"
    const parent = { postMessage(data: any) { sent.push(data.state) } }
    f.window.opener = parent
    const channel = f.exports.desktopWindowStartup(new SessionStartup(Date.now() + 500, 1))
    let started = false
    const waiting = channel.ready().then(() => { started = true })
    const send = (source: any, loadId: string) => f.window.dispatchEvent(Object.assign(new Event("message"), { source, origin, data: { type, loadId, state: "start" } }))
    send({}, "child"); send(parent, "old")
    await Promise.resolve()
    assert.equal(started, false)
    send(parent, "child")
    await waiting
    assert.deepEqual(sent, ["booting", "ready"])
    assert.equal(started, true)
})

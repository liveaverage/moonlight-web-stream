import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { SessionStartup } from "../web/session_startup.ts"

const gameSource = ts.transpileModule(readFileSync(new URL("../web/component/game/index.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

class Element extends EventTarget {
    children: any[] = []
    textContent = ""
    title = ""
    classList = { add() {}, remove() {} }
    appendChild(child: any) { this.children.push(child); return child }
    setAttribute() {}
    remove() {}
}

function fixture({ enabled = true, running = 1, cached = 1, statuses = [200], popup = true, standalone = false, budget = 500 } = {}) {
    const calls = { open: 0, focus: 0, cancel: 0, host: 0, menus: [] as any[], messages: [] as string[] }
    const document = { createElement: () => new Element(), body: new Element(), title: "" }
    const target = { closed: false, focus() { calls.focus++ }, document, location: { href: "" } }
    const window = {
        ...target,
        matchMedia: () => ({ matches: standalone }),
        open() { calls.open++; return popup ? target : null },
        setTimeout,
    }
    const gameText = {
        resumeSession: "Resume", stopCurrentSession: "Stop", showDetails: "Details", open: "Open",
        connecting: "Connecting", popupBlocked: "Allow popups", pairingRequired: "Pair first",
        otherSessionRunning: "Another app is running", connectionFailed: "Try connecting again", backToDesktops: "Back",
    }
    const exports: any = {}
    const api = {
        apiGetAppImage: async () => null,
        apiGetHost: async (_api: any, _query: any, startup: SessionStartup) => {
            // Use the real readiness/retry helper, with a simulated bridge response.
            const response = await startup.fetch("https://example.test/host", {})
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return { paired: "Paired", current_game: running }
        },
        apiHostCancel: async () => { calls.cancel++; return { success: true } },
    }
    class FastStartup extends SessionStartup {
        constructor() { super(Date.now() + budget, 1) }
        async fetch(input: RequestInfo | URL, init: RequestInit) {
            calls.host++
            return super.fetch(input, init)
        }
    }
    const modules: Record<string, any> = {
        "../index": { ComponentEvent: class extends Event { constructor(name: string) { super(name) } } },
        "../../api": api,
        "../../i18n": { getCurrentLanguage: () => "en", getTranslations: () => ({ game: gameText }) },
        "../context_menu": { setContextMenu: (_event: any, menu: any) => calls.menus.push(menu) },
        "../modal/index": { showMessage: async (message: string) => calls.messages.push(message) },
        "../../resources/index": { APP_NO_IMAGE: "" },
        "../../config_": { CONFIG: { resume_only: enabled, path_prefix: "/desktop" }, buildUrl: (path: string) => `/desktop${path}` },
        "../../session_startup": { SessionStartup: FastStartup },
    }
    runInNewContext(gameSource, { exports, require: (name: string) => {
        if (!(name in modules)) throw new Error(`Unexpected import ${name}`)
        return modules[name]
    }, document, window, URL, URLSearchParams, Event, Map, setTimeout })
    const game = new exports.Game({}, 7, 1, { app_id: 1, title: "Desktop", activeApp: cached })
    return { game, calls, target, window, statuses, standalone }
}

async function settle(f: ReturnType<typeof fixture>) {
    for (let i = 0; i < 200; i++) {
        if (f.target.location.href || f.window.location.href || f.target.document.body.textContent == "Try connecting again" || f.target.document.body.textContent == "Another app is running") return
        await new Promise(resolve => setTimeout(resolve, 2))
    }
    throw new Error("UI did not settle")
}

for (const [cached, running] of [[0, 0], [1, 1], [2, 1], [1, 0]]) {
    test(`resume-only connects from cached state ${cached} and fresh state ${running} without a stop menu`, async t => {
        t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }))
        const f = fixture({ cached, running })
        await f.game.onClick({})
        await settle(f)
        assert.match(f.target.location.href, /stream.html\?hostId=7&appId=1&connectBy=/)
        assert.equal(f.calls.cancel, 0)
        assert.equal(f.calls.menus.length, 0)
    })
}

test("repeated clicks focus the one connection window", async t => {
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }))
    const f = fixture()
    await Promise.all([f.game.onClick({}), f.game.onClick({})])
    await settle(f)
    assert.equal(f.calls.open, 1)
    assert.equal(f.calls.focus, 1)
    assert.equal(f.calls.cancel, 0)
})

test("another active app is never canceled or replaced", async t => {
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }))
    const f = fixture({ running: 2 })
    await f.game.onClick({})
    await settle(f)
    assert.equal(f.target.location.href, "")
    assert.equal(f.target.document.body.textContent, "Another app is running")
    assert.equal(f.calls.cancel, 0)
})

test("a blocked popup does not start a session", async () => {
    const f = fixture({ popup: false })
    await f.game.onClick({})
    await new Promise(resolve => setTimeout(resolve, 1))
    assert.deepEqual(f.calls.messages, ["Allow popups"])
    assert.equal(f.calls.host, 0)
})

test("standalone mode connects in the current window", async t => {
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }))
    const f = fixture({ standalone: true })
    await f.game.onClick({})
    await settle(f)
    assert.match(f.window.location.href, /stream.html/)
    assert.equal(f.calls.open, 0)
})

test("a restart during readiness checks is handled before navigation", async t => {
    const statuses = [200, 502, 503, 200, 200, 200]
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status: statuses.shift() ?? 200 }))
    const f = fixture()
    await f.game.onClick({})
    await settle(f)
    assert.match(f.target.location.href, /stream.html/)
    assert.equal(f.calls.cancel, 0)
    assert.equal(statuses.length, 0)
})

test("a timed-out bridge presents one retry message without opening a stream", async t => {
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }))
    const f = fixture({ budget: 20 })
    await f.game.onClick({})
    await settle(f)
    assert.equal(f.target.location.href, "")
    assert.equal(f.target.document.body.textContent, "Try connecting again")
    assert.equal(f.calls.open, 1)
})

test("disabled option preserves the existing resume and stop menu", async () => {
    const f = fixture({ enabled: false })
    await f.game.onClick({})
    assert.deepEqual(Array.from(f.calls.menus[0].elements, (item: any) => item.name), ["Resume", "Stop"])
    assert.equal(f.calls.open, 0)
})

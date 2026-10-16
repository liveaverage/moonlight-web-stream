import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { SessionStartup } from "../web/session_startup.ts"

const compile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const streamSource = compile("../web/stream/index.ts")
const apiSource = compile("../web/api.ts")

class FetchError extends Error {
    private status: number
    constructor(status: number) { super(`HTTP ${status}`); this.status = status }
    isTransient() { return [502, 503, 504].includes(this.status) }
}

function fixture({ enabled = true, running = 1, paired = "Paired", budget = 500, errorClass = FetchError } = {}) {
    const startup = enabled ? new SessionStartup(Date.now() + budget, 1) : null
    const calls = { host: 0, attempts: 0, closed: 0, logs: [] as string[] }
    const api = { sessionStartup: startup, FetchError: errorClass, apiGetHost: async () => {
        calls.host++
        return { paired, current_game: running }
    } }
    const exports: any = {}
    runInNewContext(streamSource, { exports, require: (name: string) => name == "../api" ? api : name == "./video" ? {
        emptyVideoCodecs: () => ({}), hasAnyCodec: () => true,
    } : {}, TypeError, Event, navigator: { userAgent: "Chromium" } })
    // Exercise the actual startup orchestration without starting media pipelines.
    const stream = Object.create(exports.Stream.prototype)
    Object.assign(stream, { api: {}, hostId: 7, appId: 1, stopped: false, connected: false,
        transport: { close: async () => { calls.closed++ } },
        debugLog: (message: string) => calls.logs.push(message),
        connectWithConfiguredTransport: async () => { calls.attempts++ },
    })
    return { stream, startup, calls, Stream: exports.Stream }
}

test("transient startup failure rechecks the host and closes the failed transport", async () => {
    const f = fixture()
    f.stream.connectWithConfiguredTransport = async () => {
        if (++f.calls.attempts == 1) throw new FetchError(503)
    }
    await f.stream.startConnection()
    assert.equal(f.calls.host, 2)
    assert.equal(f.calls.attempts, 2)
    assert.equal(f.calls.closed, 1)
})

for (const config of [{ paired: "NotPaired" }, { running: 2 }]) {
    test(`pairing or application conflict never starts a connection: ${JSON.stringify(config)}`, async () => {
        const f = fixture(config)
        await f.stream.startConnection()
        assert.equal(f.calls.attempts, 0)
        assert.equal(f.calls.host, 1)
        assert.equal(f.calls.closed, 1)
    })
}

test("authentication failure stops without retries", async () => {
    const f = fixture()
    f.stream.connectWithConfiguredTransport = async () => { f.calls.attempts++; throw new FetchError(401) }
    await f.stream.startConnection()
    assert.equal(f.calls.attempts, 1)
    assert.equal(f.calls.closed, 1)
})

test("an established stream is never automatically reconnected", async () => {
    const f = fixture()
    f.stream.connectWithConfiguredTransport = async () => {
        f.calls.attempts++
        f.stream.connected = true
        f.startup!.finish()
        throw new TypeError("active connection lost")
    }
    await f.stream.startConnection()
    assert.equal(f.calls.attempts, 1)
})

test("user stop cancels pending startup and closes the transport", async () => {
    const f = fixture()
    f.stream.connectWithConfiguredTransport = async () => {
        f.calls.attempts++
        await f.stream.stop()
        throw new TypeError("connection closed")
    }
    await f.stream.startConnection()
    assert.equal(f.calls.attempts, 1)
    assert.equal(f.startup!.signal.aborted, true)
})

test("disabled feature skips readiness and retry orchestration", async () => {
    const f = fixture({ enabled: false })
    await f.stream.startConnection()
    assert.equal(f.calls.attempts, 1)
    assert.equal(f.calls.host, 0)
    assert.equal(f.calls.logs.length, 0)
})

test("auto transport retains WebSocket fallback when WebRTC cannot connect", async () => {
    const f = fixture()
    let websocket = 0
    Object.assign(f.stream, { permissions: {}, settings: { dataTransport: "auto" }, transportOverride: null,
        tryWebRTCTransport: async () => "failednoconnect", tryWebSocketTransport: async () => { websocket++ } })
    await f.Stream.prototype.connectWithConfiguredTransport.call(f.stream)
    assert.equal(websocket, 1)
})

test("session cleanup still sends DELETE after startup cancellation", async () => {
    const exports: any = {}
    const requests: RequestInit[] = []
    runInNewContext(apiSource, { exports, require: (name: string) => {
        if (name == "./config_") return { CONFIG: { resume_only: true }, buildUrl: (path: string) => path }
        if (name == "./session_startup") return { SessionStartup }
        return {}
    }, location: { search: "", pathname: "/stream.html" }, window: { addEventListener() {} },
    URLSearchParams, AbortSignal, TypeError, DOMException, fetch: async (_url: string, init: RequestInit) => {
        requests.push(init)
        return new Response(null, { status: 204 })
    } })
    exports.sessionStartup.cancel()
    await exports.fetchApi({ host_url: "/api", bearer: null }, "/session/1", "DELETE", { keepalive: true, response: "ignore" })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, "DELETE")
    assert.equal(requests[0].signal?.aborted, false)
})

for (const enabled of [true, false]) {
    test(`capability worker load failure retries only when resume-only is ${enabled}`, async () => {
        const f = fixture({ enabled })
        Object.assign(f.stream, { settings: { videoCodec: "h264" }, streamerSize: [1920, 1080],
            queryVideoCodecs: async () => {
                if (f.calls.attempts === 1) throw new Event("error")
                return { h264: true }
            },
            connectWithConfiguredTransport: async () => {
                f.calls.attempts++
                return f.Stream.prototype.createTransportOptions.call(f.stream)
            },
        })
        if (enabled) {
            await f.stream.startConnection()
            assert.equal(f.calls.attempts, 2)
            assert.equal(f.calls.host, 2)
        } else {
            await assert.rejects(f.stream.startConnection(), error => error instanceof Event)
            assert.equal(f.calls.attempts, 1)
        }
    })
}

test("a stuck media capability probe cannot outlive the connection budget", async () => {
    const f = fixture({ budget: 20 })
    Object.assign(f.stream, { settings: { videoCodec: "h264" },
        queryVideoCodecs: () => new Promise(() => {}),
        connectWithConfiguredTransport: () => f.Stream.prototype.createTransportOptions.call(f.stream),
    })
    await f.stream.startConnection()
    assert(f.calls.logs.some(message => message.includes("30 seconds")))
    assert.equal(f.calls.host, 1)
})

test("the outer startup loop does not replay ambiguous stream-creation failures", async () => {
    const exports: any = {}
    runInNewContext(apiSource, { exports, require: (name: string) => {
        if (name == "./config_") return { CONFIG: { resume_only: true } }
        if (name == "./session_startup") return { SessionStartup, isTransientStartupStatus: (status: number) => [502, 503, 504].includes(status) }
        return {}
    }, location: { search: "", pathname: "/" }, window: { addEventListener() {} }, URLSearchParams, TypeError, DOMException })
    for (const error of [
        new exports.FetchError("unknown", "/host/stream/webrtc", "POST", new TypeError("response lost")),
        new exports.FetchError("failed", "/host/stream/webrtc", "POST", new Response(null, { status: 502 })),
    ]) {
        const f = fixture({ errorClass: exports.FetchError })
        f.stream.connectWithConfiguredTransport = async () => { f.calls.attempts++; throw error }
        await f.stream.startConnection()
        assert.equal(f.calls.attempts, 1)
        assert.equal(f.calls.host, 1)
    }
    assert.equal(new exports.FetchError("failed", "/host", "GET", new Response(null, { status: 503 })).isTransient(), true)
})

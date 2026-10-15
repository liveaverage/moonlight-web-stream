import assert from "node:assert/strict"
import test from "node:test"
import { SessionStartup, SessionStartupTimeout } from "../web/session_startup.ts"

test("recovers from bridge restart responses within one deadline", async t => {
    const statuses = [502, 503, 504, 200]
    const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: statuses.shift() }))
    const startup = new SessionStartup(Date.now() + 500, 1)
    assert.equal((await startup.fetch("https://example.test/host", {})).status, 200)
    assert.equal(fetch.mock.callCount(), 4)
    assert.equal(startup.retries, 3)
})

test("network interruption can recover without stopping the application", async t => {
    let calls = 0
    t.mock.method(globalThis, "fetch", async () => {
        if (++calls == 1) throw new TypeError("network unavailable")
        return new Response(null, { status: 200 })
    })
    const startup = new SessionStartup(Date.now() + 500, 1)
    await startup.fetch("https://example.test/host", { method: "GET" })
    assert.equal(calls, 2)
})

for (const status of [400, 401, 403, 404, 409, 500]) {
    test(`does not retry authentication, pairing, conflict or permanent HTTP ${status}`, async t => {
        const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status }))
        const startup = new SessionStartup(Date.now() + 500, 1)
        assert.equal((await startup.fetch("https://example.test/host", {})).status, status)
        assert.equal(fetch.mock.callCount(), 1)
    })
}

test("does not replay a stream-creation POST after an ambiguous failure", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 502 }))
    const startup = new SessionStartup(Date.now() + 500, 1)
    assert.equal((await startup.fetch("https://example.test/stream", { method: "POST" }, false)).status, 502)
    assert.equal(fetch.mock.callCount(), 1)
})

test("repeated readiness requests share the deadline instead of resetting it", async t => {
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }))
    const startup = new SessionStartup(Date.now() + 20, 1)
    await assert.rejects(startup.fetch("https://example.test/host", {}), SessionStartupTimeout)
    await assert.rejects(startup.fetch("https://example.test/host", {}), SessionStartupTimeout)
})

test("cancel stops readiness retries immediately", async t => {
    const startup = new SessionStartup(Date.now() + 500, 1)
    const fetch = t.mock.method(globalThis, "fetch", async () => {
        startup.cancel()
        return new Response(null, { status: 503 })
    })
    await assert.rejects(startup.fetch("https://example.test/host", {}), { name: "AbortError" })
    assert.equal(fetch.mock.callCount(), 1)
})

test("an established stream does not retain the startup deadline or retry writes", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }))
    const startup = new SessionStartup(Date.now() - 1, 1)
    startup.finish()
    assert.equal((await startup.fetch("https://example.test/clipboard", { method: "PUT" })).status, 503)
    assert.equal(fetch.mock.callCount(), 1)
})

test("does not launch a pending operation after its deadline", async () => {
    const startup = new SessionStartup(Date.now() - 1)
    let launched = false
    await assert.rejects(startup.withinBudget(async () => { launched = true }), SessionStartupTimeout)
    assert.equal(launched, false)
})

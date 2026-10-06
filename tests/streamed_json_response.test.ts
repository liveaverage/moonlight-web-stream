import assert from "node:assert/strict"
import test from "node:test"
import { StreamedJsonResponse } from "../web/streamed_json_response.ts"

function stream(chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk)
            controller.close()
        },
    }).getReader()
}

test("preserves multiple JSON updates delivered in one chunk", async () => {
    const reader = stream([new TextEncoder().encode('{"host":1}\n{"host":2}\n{"host":3}\n')])
    const response = new StreamedJsonResponse<null, { host: number }>(reader, null)

    assert.deepEqual(await response.next(), { host: 1 })
    assert.deepEqual(await response.next(), { host: 2 })
    assert.deepEqual(await response.next(), { host: 3 })
    assert.equal(await response.next(), null)
})

test("preserves a JSON update split across UTF-8 chunks", async () => {
    const bytes = new TextEncoder().encode('{"name":"café"}\n')
    const accent = bytes.indexOf(0xc3)
    const reader = stream([bytes.slice(0, accent + 1), bytes.slice(accent + 1)])
    const response = new StreamedJsonResponse<null, { name: string }>(reader, null)

    assert.deepEqual(await response.next(), { name: "café" })
    assert.equal(await response.next(), null)
})

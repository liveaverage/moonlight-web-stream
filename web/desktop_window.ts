import { SessionStartup } from "./session_startup"

const MESSAGE_TYPE = "moonlight-viewer-startup"

/** Keep the picker in control until the viewer has loaded its scripts and WASM. */
export async function openDesktopWindow(target: Window, address: string, startup: SessionStartup, beforeReload: () => Promise<void>): Promise<boolean> {
    let loadId = ""
    let booting = false
    let reload = false
    let ready = false
    let resolveReady: () => void
    let rejectReady: (error: Error) => void
    const loaded = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    const origin = window.location.origin
    const message = (event: MessageEvent) => {
        if (event.source !== target || event.origin !== origin || event.data?.type !== MESSAGE_TYPE || event.data.loadId !== loadId) return
        if (event.data.state === "booting") booting = true
        else if (event.data.state === "retry") { booting = false; reload = true }
        else if (event.data.state === "failed") rejectReady(new Error("The desktop viewer could not initialize."))
        else if (event.data.state === "ready") {
            ready = true
            // The child cannot start a stream until this grant, so reloading a failed page never replays a launch.
            target.postMessage({ type: MESSAGE_TYPE, loadId, state: "start" }, origin)
            resolveReady()
        }
    }
    const navigate = () => {
        loadId = crypto.randomUUID()
        booting = false
        reload = false
        const url = new URL(address, window.location.href)
        url.searchParams.set("loadId", loadId)
        target.location.href = url.href
    }
    window.addEventListener("message", message)
    try {
        navigate()
        while (!ready) {
            if (target.closed) return false
            await Promise.race([loaded, startup.pause()])
            if (ready) break
            if (!booting) {
                try {
                    reload ||= target.location.href !== "about:blank" && target.document.readyState === "complete"
                } catch {
                    // Browsers isolate their connection-error documents from the opener.
                    reload = true
                }
            }
            if (reload) {
                await beforeReload()
                if (!ready && !target.closed) navigate()
            }
        }
        return true
    } finally {
        window.removeEventListener("message", message)
    }
}

/** Announce bootstrap progress, then wait for the picker to allow stream creation. */
export function desktopWindowStartup(startup: SessionStartup) {
    const loadId = new URLSearchParams(window.location.search).get("loadId")
    const parent = window.opener
    if (!loadId || !parent) return null
    const origin = window.location.origin
    const send = (state: string) => parent.postMessage({ type: MESSAGE_TYPE, loadId, state }, origin)
    send("booting")
    return {
        retry: () => send("retry"),
        fail: () => send("failed"),
        ready: async () => {
            let grant: ((event: MessageEvent) => void) | undefined
            try {
                await startup.withinBudget(() => new Promise<void>(resolve => {
                    grant = event => {
                        if (event.source === parent && event.origin === origin && event.data?.type === MESSAGE_TYPE && event.data.loadId === loadId && event.data.state === "start") resolve()
                    }
                    window.addEventListener("message", grant)
                    send("ready")
                }))
            } finally {
                if (grant) window.removeEventListener("message", grant)
            }
        },
    }
}

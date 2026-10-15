import { Component, ComponentEvent } from "../index"
import { Api, apiGetAppImage, apiGetHost, apiHostCancel } from "../../api"
import { App } from "../../api_bindings"
import { getCurrentLanguage, getTranslations } from "../../i18n"
import { setContextMenu } from "../context_menu"
import { showMessage } from "../modal/index"
import { APP_NO_IMAGE } from "../../resources/index"
import { CONFIG, buildUrl } from "../../config_"
import { SessionStartup } from "../../session_startup"

export type GameCache = App & { activeApp: number | null }

export type GameEventListener = (event: ComponentEvent<Game>) => void

export class Game implements Component {
    private static desktopWindows = new Map<string, Window>()
    private api: Api

    private hostId: number
    private appId: number

    private mounted: number = 0
    private divElement: HTMLDivElement = document.createElement("div")

    private imageBlob: Blob | null = null
    private imageBlobUrl: string | null = null
    private imageElement: HTMLImageElement = document.createElement("img")

    private cache: GameCache

    constructor(api: Api, hostId: number, appId: number, cache: GameCache) {
        this.api = api

        this.hostId = hostId
        this.appId = appId

        this.cache = cache

        // Configure image
        this.imageElement.classList.add("app-image")
        this.imageElement.src = APP_NO_IMAGE

        this.forceLoadImage(false)

        // Configure div
        this.divElement.classList.add("app")

        this.divElement.appendChild(this.imageElement)

        this.divElement.addEventListener("click", this.onClick.bind(this))
        this.divElement.addEventListener("contextmenu", this.onContextMenu.bind(this))

        this.updateCache(cache)
    }

    async forceLoadImage(forceServerRefresh: boolean) {
        this.imageBlob = await apiGetAppImage(this.api, {
            host_id: this.hostId,
            app_id: this.appId,
            force_refresh: forceServerRefresh
        })

        this.updateImage()
    }
    private updateImage() {
        // generate and set url
        if (this.imageBlob && !this.imageBlobUrl && this.mounted > 0) {
            this.imageBlobUrl = URL.createObjectURL(this.imageBlob)

            this.imageElement.classList.add("app-image-loaded")
            this.imageElement.src = this.imageBlobUrl
        }

        // revoke url
        if (this.imageBlobUrl && this.mounted <= 0) {
            URL.revokeObjectURL(this.imageBlobUrl)
            this.imageBlobUrl = null

            this.imageElement.classList.remove("app-image-loaded")
            this.imageElement.src = ""
        }
    }

    updateCache(cache: GameCache) {
        this.cache = cache

        this.divElement.classList.remove("app-inactive")
        this.divElement.classList.remove("app-active")

        if (this.isActive()) {
            this.divElement.classList.add("app-active")
        } else if (this.cache.activeApp != null) {
            this.divElement.classList.add("app-inactive")
        }
    }

    private async onClick(event: MouseEvent) {
        const i = getTranslations(getCurrentLanguage()).game
        if (CONFIG.resume_only) {
            this.startStream()
            return
        }
        if (this.cache.activeApp != null) {
            const elements = []

            if (this.isActive()) {
                elements.push({
                    name: i.resumeSession,
                    callback: async () => {
                        this.startStream()

                        const event = new ComponentEvent("ml-gamereload", this)
                        this.divElement.dispatchEvent(event)
                    }
                })
            }

            elements.push({
                name: i.stopCurrentSession,
                callback: async () => {
                    const response = await apiHostCancel(this.api, { host_id: this.hostId })
                    if (!response.success) {
                        await showMessage(i.failedToCloseApp)
                    }

                    const event = new ComponentEvent("ml-gamereload", this)
                    this.divElement.dispatchEvent(event)
                }
            })

            setContextMenu(event, {
                elements
            })
        } else {
            this.startStream()

            await new Promise(r => window.setTimeout(r, 6000))

            const event = new ComponentEvent("ml-gamereload", this)
            this.divElement.dispatchEvent(event)
        }
    }
    private async startDesktopStream() {
        const i = getTranslations(getCurrentLanguage()).game
        const key = `${CONFIG.path_prefix}:${this.hostId}`
        const existing = Game.desktopWindows.get(key)
        if (existing && !existing.closed) {
            existing.focus()
            return
        }
        const standalone = window.matchMedia('(display-mode: standalone)').matches
        const target = standalone ? window : window.open("", `moonlight-${key}`)
        if (!target) {
            await showMessage(i.popupBlocked)
            return
        }
        Game.desktopWindows.set(key, target)
        const status = document.createElement("p")
        status.textContent = i.connecting
        status.setAttribute("role", "status")
        this.divElement.appendChild(status)
        const startup = new SessionStartup()
        if (!standalone) {
            target.document.title = i.connecting
            target.document.body.textContent = i.connecting
        }
        try {
            // Observe a short stable interval so a scheduled restart cannot look ready for just one probe.
            let ready = 0
            while (ready < 3) {
                if (target.closed) return
                const retries = startup.retries
                const host = await apiGetHost(this.api, { host_id: this.hostId }, startup)
                if (host.paired != "Paired") throw new Error(i.pairingRequired)
                if (host.current_game != 0 && host.current_game != this.appId) throw new Error(i.otherSessionRunning)
                if (startup.retries != retries) ready = 0
                ready++
                if (ready < 3) await startup.pause()
            }
            if (target.closed) return
            const query = new URLSearchParams({ hostId: String(this.hostId), appId: String(this.appId), connectBy: String(startup.deadline) })
            target.location.href = buildUrl(`/stream.html?${query}`)
            this.divElement.dispatchEvent(new ComponentEvent("ml-gamereload", this))
        } catch (error) {
            Game.desktopWindows.delete(key)
            const message = error instanceof Error && [i.pairingRequired, i.otherSessionRunning].includes(error.message)
                ? error.message : i.connectionFailed
            if (!standalone && !target.closed) {
                target.document.body.textContent = message
                const back = target.document.createElement("a")
                back.href = buildUrl("/")
                back.textContent = i.backToDesktops
                target.document.body.appendChild(back)
            } else {
                await showMessage(message)
            }
        } finally {
            status.remove()
        }
    }

    private startStream() {
        if (CONFIG.resume_only) {
            void this.startDesktopStream()
            return
        }

        let query = new URLSearchParams({
            hostId: this.getHostId(),
            appId: this.getAppId(),
        } as any)

        if (window.matchMedia('(display-mode: standalone)').matches) {
            // If we're in a pwa: open in the current tab
            // If we don't do this we might get a url bar at the top
            window.location.href = buildUrl(`/stream.html?${query}`)
        } else {
            window.open(buildUrl(`/stream.html?${query}`), "_blank")
        }
    }

    private onContextMenu(event: MouseEvent) {
        const i = getTranslations(getCurrentLanguage()).game
        const elements = []

        elements.push({
            name: i.showDetails,
            callback: this.showDetails.bind(this),
        })

        elements.push({
            name: i.open,
            callback: async () => {
                this.startStream()

                const event = new ComponentEvent("ml-gamereload", this)
                this.divElement.dispatchEvent(event)
            }
        })

        setContextMenu(event, {
            elements
        })
    }

    private async showDetails() {
        const app = this.cache
        const i = getTranslations(getCurrentLanguage()).game
        await showMessage(i.details(app))
    }

    private isActive(): boolean {
        return this.cache.activeApp == this.appId
    }

    addForceReloadListener(listener: GameEventListener) {
        this.divElement.addEventListener("ml-gamereload", listener as any)
    }
    removeForceReloadListener(listener: GameEventListener) {
        this.divElement.removeEventListener("ml-gamereload", listener as any)
    }

    getHostId(): number {
        return this.hostId
    }
    getAppId(): number {
        return this.appId
    }

    mount(parent: HTMLElement): void {
        this.mounted++
        this.updateImage()

        parent.appendChild(this.divElement)
    }
    unmount(parent: HTMLElement): void {

        parent.removeChild(this.divElement)

        this.mounted--
        this.updateImage()
    }
}

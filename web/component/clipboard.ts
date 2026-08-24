import { Api, apiGetClipboard, apiGetClipboardStatus, apiPutClipboard, FetchError } from "../api"
import { CONFIG } from "../config_"
import { getCurrentLanguage, getTranslations } from "../i18n"
import { showNotification } from "./notification"
import { Component } from "./index"

export type ClipboardComponentOptions = {
    shortcutsEnabled: boolean,
    pasteText: (text: string) => void,
    pasteRemoteClipboard: () => void,
    copyRemoteSelection: () => void,
    shortcutsChanged: (enabled: boolean) => void,
}

export class ClipboardComponent implements Component {
    private root = document.createElement("section")
    private editor = document.createElement("textarea")
    private shortcutCheckbox = document.createElement("input")
    private copyButton = document.createElement("button")
    private copyOutAvailable = false
    private api: Api
    private hostId: number
    private options: ClipboardComponentOptions
    private i = getTranslations(getCurrentLanguage()).stream

    constructor(api: Api, hostId: number, options: ClipboardComponentOptions) {
        this.api = api
        this.hostId = hostId
        this.options = options

        this.root.classList.add("stream-clipboard")

        const heading = document.createElement("h3")
        heading.innerText = this.i.clipboard
        this.root.appendChild(heading)

        this.editor.classList.add("stream-clipboard-editor")
        this.editor.placeholder = this.i.clipboardPlaceholder
        this.editor.ariaLabel = this.i.clipboardPlaceholder
        this.editor.rows = 4
        this.editor.spellcheck = false
        this.editor.autocomplete = "off"
        this.root.appendChild(this.editor)

        const actions = document.createElement("div")
        actions.classList.add("stream-clipboard-actions")

        actions.appendChild(this.makeButton(this.i.pasteToDesktop, () => {
            void this.pasteToDesktop(this.editor.value)
        }))
        actions.appendChild(this.makeButton(this.i.pasteBrowserClipboard, () => {
            void this.pasteBrowserClipboard()
        }))

        this.copyButton = this.makeButton(this.i.copyFromDesktop, () => {
            void this.copySelectionFromDesktop()
        })
        this.copyButton.disabled = true
        this.copyButton.title = this.i.clipboardBridgeDisabled
        actions.appendChild(this.copyButton)
        this.root.appendChild(actions)

        const shortcutLabel = document.createElement("label")
        shortcutLabel.classList.add("stream-clipboard-shortcuts")
        this.shortcutCheckbox.type = "checkbox"
        this.shortcutCheckbox.checked = options.shortcutsEnabled
        this.shortcutCheckbox.addEventListener("change", () => {
            this.options.shortcutsChanged(this.shortcutCheckbox.checked)
        })
        shortcutLabel.appendChild(this.shortcutCheckbox)
        shortcutLabel.append(document.createTextNode(this.i.clipboardShortcuts))
        this.root.appendChild(shortcutLabel)

        void this.loadCopyOutAvailability()
    }

    private async loadCopyOutAvailability(): Promise<void> {
        try {
            const status = await apiGetClipboardStatus(this.api, this.hostId)
            this.copyOutAvailable = status.configured
            this.copyButton.disabled = !status.configured
            this.copyButton.title = status.configured ? "" : this.i.clipboardBridgeDisabled
        } catch (error) {
            console.warn("Failed to determine clipboard companion availability.", error)
        }
    }

    private makeButton(label: string, action: () => void): HTMLButtonElement {
        const button = document.createElement("button")
        button.type = "button"
        button.innerText = label
        button.addEventListener("click", action)
        return button
    }

    async pasteBrowserClipboard(): Promise<void> {
        if (!navigator.clipboard?.readText) {
            showNotification(this.i.clipboardReadFailed, "warn")
            this.editor.focus()
            return
        }

        try {
            const text = await navigator.clipboard.readText()
            this.editor.value = text
            await this.pasteToDesktop(text)
        } catch (error) {
            showNotification(this.i.clipboardReadFailed, "warn", error)
            this.editor.focus()
        }
    }

    async pasteToDesktop(text: string): Promise<void> {
        if (!text) {
            showNotification(this.i.clipboardEmpty, "warn")
            return
        }
        if (new TextEncoder().encode(text).byteLength > CONFIG.clipboard_max_text_bytes) {
            showNotification(this.i.clipboardTooLarge, "warn")
            return
        }

        if (this.copyOutAvailable) {
            try {
                await apiPutClipboard(this.api, this.hostId, text)
                this.options.pasteRemoteClipboard()
                showNotification(this.i.clipboardPasted, "info")
                return
            } catch (error) {
                if (error instanceof FetchError && error.getResponse()?.status === 413) {
                    showNotification(this.i.clipboardTooLarge, "warn")
                    return
                }
                // The Moonlight text packet is the reliable no-companion fallback.
                console.warn("Clipboard companion paste failed; falling back to Moonlight text input.", error)
            }
        }

        this.options.pasteText(text)
        showNotification(this.i.clipboardPasted, "info")
    }

    async copyFromDesktop(): Promise<void> {
        if (!this.copyOutAvailable) {
            showNotification(this.i.clipboardBridgeDisabled, "warn")
            return
        }

        try {
            const { text } = await apiGetClipboard(this.api, this.hostId)
            this.editor.value = text

            try {
                await navigator.clipboard.writeText(text)
                showNotification(this.i.clipboardCopied, "info")
            } catch (error) {
                this.editor.focus()
                this.editor.select()
                showNotification(this.i.clipboardWriteFailed, "warn", error)
            }
        } catch (error) {
            const message = error instanceof FetchError && error.getResponse()?.status === 413
                ? this.i.clipboardTooLarge
                : this.i.clipboardDesktopFailed
            showNotification(message, "warn", error)
        }
    }

    async copySelectionFromDesktop(): Promise<void> {
        if (!this.isCopyOutAvailable()) {
            showNotification(this.i.clipboardBridgeDisabled, "warn")
            return
        }

        this.options.copyRemoteSelection()
        await new Promise(resolve => window.setTimeout(resolve, 350))
        await this.copyFromDesktop()
    }

    isCopyOutAvailable(): boolean {
        return this.copyOutAvailable
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.root)
    }

    unmount(parent: HTMLElement): void {
        parent.removeChild(this.root)
    }
}

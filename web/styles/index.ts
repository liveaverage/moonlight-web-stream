import { globalDefaultSettings, getLocalStreamSettings } from "../component/settings_menu"
import { getCustomTheme, PageStyle } from "./themes"

// CSS is injected lazily so only the selected theme affects the page.
import standardUrl from "./standard.css"
import moonlightUrl from "./moonlight.css"
import themeContractUrl from "./theme-contract.css"
import nvidiaUrl from "./nvidia.css"
import clipboardUrl from "./clipboard.css"
import { disableNvidiaGeometry, enableNvidiaGeometry } from "./nvidia_geometry"

let currentStyle: PageStyle | null = null
let activeModules: LazyStyleModule[] = []
let customStylesheet: HTMLLinkElement | null = null

const styleMap: Record<string, LazyStyleModule[]> = {
    standard: [standardUrl, themeContractUrl, clipboardUrl],
    old: [moonlightUrl, clipboardUrl],
    moonlight: [moonlightUrl, clipboardUrl],
    nvidia: [standardUrl, themeContractUrl, nvidiaUrl, clipboardUrl],
}

function removeCurrentStyle() {
    disableNvidiaGeometry()

    for (const styleModule of [...activeModules].reverse()) {
        styleModule.unuse()
    }
    activeModules = []

    customStylesheet?.remove()
    customStylesheet = null
}

export function setStyle(requestedStyle: PageStyle) {
    if (currentStyle === requestedStyle) {
        return
    }

    removeCurrentStyle()

    const customTheme = getCustomTheme()
    let resolvedStyle = requestedStyle
    let modules = styleMap[requestedStyle]

    if (!modules && customTheme?.id === requestedStyle) {
        modules = styleMap.standard
    } else if (!modules) {
        console.warn(`Unknown theme "${requestedStyle}"; using Standard.`)
        resolvedStyle = "standard"
        modules = styleMap.standard
    }

    for (const styleModule of modules) {
        styleModule.use()
    }
    activeModules = modules

    if (customTheme?.id === resolvedStyle) {
        const link = document.createElement("link")
        link.rel = "stylesheet"
        link.href = customTheme.stylesheet
        link.dataset.moonlightTheme = customTheme.id
        link.addEventListener("error", () => {
            console.error(`Failed to load custom theme stylesheet: ${customTheme.stylesheet}`)
        })
        document.head.appendChild(link)
        customStylesheet = link
    }

    document.documentElement.dataset.theme = resolvedStyle
    if (resolvedStyle === "nvidia") {
        enableNvidiaGeometry()
    }
    currentStyle = resolvedStyle
}

export function getStyle(): PageStyle {
    return currentStyle ?? "standard"
}

const settings = getLocalStreamSettings(globalDefaultSettings())
setStyle(settings.pageStyle)

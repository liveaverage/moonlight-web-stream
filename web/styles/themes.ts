import { CONFIG } from "../config_"

export type PageStyle = string

export type ThemeOption = {
    value: string,
    name: string,
}

export type CustomTheme = {
    id: string,
    label: string,
    stylesheet: string,
}

const RESERVED_THEME_IDS = new Set(["standard", "old", "moonlight", "nvidia"])

export function getCustomTheme(): CustomTheme | null {
    const theme = CONFIG.custom_theme
    if (!theme) {
        return null
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(theme.id) || RESERVED_THEME_IDS.has(theme.id)) {
        console.warn(`Ignoring custom theme with invalid or reserved id "${theme.id}".`)
        return null
    }
    if (!theme.label.trim() || !theme.stylesheet.trim()) {
        console.warn(`Ignoring incomplete custom theme "${theme.id}".`)
        return null
    }

    return {
        id: theme.id,
        label: theme.label,
        stylesheet: new URL(theme.stylesheet, document.baseURI).href,
    }
}

export function getThemeOptions(): ThemeOption[] {
    const themes: ThemeOption[] = [
        { value: "standard", name: "Standard" },
        { value: "moonlight", name: "Moonlight" },
        { value: "nvidia", name: "NVIDIA" },
    ]
    const customTheme = getCustomTheme()
    if (customTheme) {
        themes.push({ value: customTheme.id, name: customTheme.label })
    }
    return themes
}

export function normalizeThemeId(themeId: unknown): string {
    if (themeId === "old") {
        return "moonlight"
    }
    if (typeof themeId !== "string") {
        return "standard"
    }

    const available = new Set(getThemeOptions().map(theme => theme.value))
    return available.has(themeId) ? themeId : "standard"
}

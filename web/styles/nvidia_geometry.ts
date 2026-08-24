/*
 * Adapted from LaunchPad Docs' deterministic triangular-mesh treatment:
 * lp/util/roles/docs/files/docsify-base/_static/js/launchpad-v2.js
 */

type Point = { x: number, y: number }
type Triangle = [Point, Point, Point]

const config = {
    columns: 11,
    rows: 8,
    // Start off-canvas so the mesh itself spans the complete viewport. Its
    // visibility curve, rather than its geometry, creates the left-side fade.
    xStartRatio: -0.16,
    xStepDivisor: 7.4,
    yStepDivisor: 5.8,
    cycleDuration: 13500,
    xMinRatio: -0.08,
    xMaxRatio: 1.08,
    yCenterRatio: 0.3,
    yAmplitudeRatio: 0.19,
    pathOffset: 0.18,
    highlightRadiusRatio: 0.25,
    trailLength: 6,
    trailPhase: 0.018,
    pulseFill: 0.052,
    pulseStroke: 0.105,
    glowAlpha: 0.018,
}

let cleanupGeometry: (() => void) | null = null
let pendingStart: (() => void) | null = null

const kaizenClasses = [
    "nv-app-bar-root",
    "nv-button",
    "nv-button--color-brand",
    "nv-button--color-danger",
    "nv-button--color-neutral",
    "nv-button--kind-primary",
    "nv-button--kind-secondary",
    "nv-button--kind-tertiary",
    "nv-button--size-medium",
    "nv-card-root",
    "nv-card-root--interactive",
]

const clamp = (value: number, minimum: number, maximum: number) =>
    Math.min(Math.max(value, minimum), maximum)

const smoothstep = (value: number) => {
    const bounded = clamp(value, 0, 1)
    return bounded * bounded * (3 - 2 * bounded)
}

const smootherstep = (value: number) => {
    const bounded = clamp(value, 0, 1)
    return bounded * bounded * bounded * (bounded * (bounded * 6 - 15) + 10)
}

const seed = (row: number, column: number, axis: number) =>
    Math.sin((row + 1) * 91.7 + (column + 1) * 47.3 + axis * 19.1)

const backgroundVisibility = (x: number, width: number) =>
    smoothstep(clamp(x / width, 0, 1) / 0.46)

function decorateKaizenElement(element: Element, decorated: Set<Element>) {
    const add = (...classes: string[]) => {
        element.classList.add(...classes)
        decorated.add(element)
    }

    if (element.matches(".top-line")) {
        add("nv-app-bar-root")
    }

    if (element.matches(".host-element, .app-element > div")) {
        add("nv-card-root", "nv-card-root--interactive")
    }

    if (element.matches("button, .file-button")) {
        add("nv-button", "nv-button--size-medium")

        if (element.matches(".logout-button, .login-button, .admin-button, .user-button, .open-settings, .sidebar-button")) {
            add("nv-button--kind-tertiary", "nv-button--color-neutral")
        } else if (element.matches(".user-info-delete, .role-info-delete, .context-menu-element-red")) {
            add("nv-button--kind-secondary", "nv-button--color-danger")
        } else if (element.matches("button[type='submit'], .host-add, [data-variant='save-button'], .file-button")) {
            add("nv-button--kind-primary", "nv-button--color-brand")
        } else {
            add("nv-button--kind-secondary", "nv-button--color-neutral")
        }
    }
}

function enableKaizenRuntime() {
    const decorated = new Set<Element>()
    document.documentElement.classList.add("nv-dark", "nv-density-standard")

    const decorateTree = (root: ParentNode) => {
        if (root instanceof Element) decorateKaizenElement(root, decorated)
        root.querySelectorAll(".top-line, .host-element, .app-element > div, button, .file-button")
            .forEach(element => decorateKaizenElement(element, decorated))
    }

    decorateTree(document)
    const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node instanceof Element) decorateTree(node)
            }
        }
    })
    observer.observe(document.body, { childList: true, subtree: true })

    return () => {
        observer.disconnect()
        document.documentElement.classList.remove("nv-dark", "nv-density-standard")
        for (const element of decorated) {
            element.classList.remove(...kaizenClasses)
        }
    }
}

function fieldPosition(phase: number, width: number, height: number) {
    const wrappedPhase = (phase + 1) % 1
    const outwardProgress = wrappedPhase < 0.5 ? wrappedPhase * 2 : (1 - wrappedPhase) * 2
    const travelProgress = smootherstep(outwardProgress)

    return {
        x: width * (config.xMinRatio + (config.xMaxRatio - config.xMinRatio) * travelProgress),
        y: height * (
            config.yCenterRatio
            + Math.sin(wrappedPhase * Math.PI * 2 + config.pathOffset) * config.yAmplitudeRatio
        ),
    }
}

function createGeometry() {
    const disableKaizenRuntime = enableKaizenRuntime()
    const canvas = document.createElement("canvas")
    canvas.className = "nvidia-geometric-surface"
    canvas.setAttribute("aria-hidden", "true")
    document.body.prepend(canvas)

    const context = canvas.getContext("2d")
    if (!context) {
        disableKaizenRuntime()
        canvas.remove()
        return () => undefined
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    let width = 1
    let height = 1
    let points: Point[][] = []
    let animationFrame: number | null = null
    const resize = () => {
        const ratio = Math.min(window.devicePixelRatio || 1, 2)
        width = Math.max(window.innerWidth, 1)
        height = Math.max(window.innerHeight, 1)
        canvas.width = Math.round(width * ratio)
        canvas.height = Math.round(height * ratio)
        context.setTransform(ratio, 0, 0, ratio, 0, 0)

        const xStep = width / config.xStepDivisor
        const yStep = height / config.yStepDivisor
        const xStart = width * config.xStartRatio
        const yStart = -yStep

        points = Array.from({ length: config.rows }, (_, row) =>
            Array.from({ length: config.columns }, (_, column) => ({
                x: xStart + column * xStep + (row % 2 ? xStep / 2 : 0)
                    + seed(row, column, 0) * xStep * 0.2,
                y: yStart + row * yStep + seed(row, column, 1) * yStep * 0.16,
            })),
        )
    }

    const traceTriangle = (triangle: Triangle) => {
        context.beginPath()
        context.moveTo(triangle[0].x, triangle[0].y)
        context.lineTo(triangle[1].x, triangle[1].y)
        context.lineTo(triangle[2].x, triangle[2].y)
        context.closePath()
    }

    const drawBaseTriangle = (triangle: Triangle, index: number) => {
        const centerX = triangle.reduce((sum, point) => sum + point.x, 0) / 3
        const visibility = backgroundVisibility(centerX, width)
        const baseAlpha = (0.004 + ((index * 13) % 7) * 0.001) * visibility
        traceTriangle(triangle)
        context.fillStyle = `rgba(255, 255, 255, ${baseAlpha})`
        context.strokeStyle = `rgba(255, 255, 255, ${0.032 * visibility})`
        context.lineWidth = 0.75
        context.fill()
        context.stroke()
    }

    const drawTravelingField = (triangles: Triangle[], phase: number) => {
        const field = fieldPosition(phase, width, height)
        const radius = width * config.highlightRadiusRatio
        const trail = Array.from({ length: config.trailLength }, (_, index) => ({
            ...fieldPosition(phase - index * config.trailPhase, width, height),
            weight: Math.pow(0.7, index),
        }))

        context.save()
        context.lineJoin = "round"

        const glow = context.createRadialGradient(field.x, field.y, 0, field.x, field.y, radius * 1.15)
        const fieldVisibility = backgroundVisibility(field.x, width)
        glow.addColorStop(0, `rgba(118, 185, 0, ${config.glowAlpha * fieldVisibility})`)
        glow.addColorStop(0.5, `rgba(118, 185, 0, ${config.glowAlpha * fieldVisibility * 0.38})`)
        glow.addColorStop(1, "rgba(118, 185, 0, 0)")
        context.fillStyle = glow
        context.fillRect(field.x - radius * 1.15, field.y - radius * 1.15, radius * 2.3, radius * 2.3)

        for (const triangle of triangles) {
            const centerX = triangle.reduce((sum, point) => sum + point.x, 0) / 3
            const centerY = triangle.reduce((sum, point) => sum + point.y, 0) / 3
            const intensity = trail.reduce((strongest, sample) => {
                const proximity = Math.max(0, 1 - Math.hypot(centerX - sample.x, centerY - sample.y) / radius)
                return Math.max(strongest, smoothstep(proximity) * sample.weight)
            }, 0) * backgroundVisibility(centerX, width)

            if (intensity <= 0.008) continue

            traceTriangle(triangle)
            context.fillStyle = `rgba(118, 185, 0, ${intensity * config.pulseFill})`
            context.strokeStyle = `rgba(143, 203, 43, ${intensity * config.pulseStroke})`
            context.lineWidth = 0.75 + intensity * 0.34
            context.shadowColor = "rgba(118, 185, 0, 0.22)"
            context.shadowBlur = intensity * 6
            context.fill()
            context.stroke()
        }

        context.restore()
    }

    const draw = (time = 0) => {
        animationFrame = null
        context.clearRect(0, 0, width, height)

        const triangles: Triangle[] = []
        let triangleIndex = 0
        for (let row = 0; row < config.rows - 1; row += 1) {
            for (let column = 0; column < config.columns - 1; column += 1) {
                const topLeft = points[row][column]
                const topRight = points[row][column + 1]
                const bottomLeft = points[row + 1][column]
                const bottomRight = points[row + 1][column + 1]
                const cellTriangles: [Triangle, Triangle] = (row + column) % 2 === 0
                    ? [[topLeft, topRight, bottomRight], [topLeft, bottomRight, bottomLeft]]
                    : [[topLeft, topRight, bottomLeft], [topRight, bottomRight, bottomLeft]]

                for (const triangle of cellTriangles) {
                    triangles.push(triangle)
                    drawBaseTriangle(triangle, triangleIndex++)
                }
            }
        }

        if (!reducedMotion.matches) {
            drawTravelingField(triangles, (time % config.cycleDuration) / config.cycleDuration)
            animationFrame = window.requestAnimationFrame(draw)
        }
    }

    const redraw = () => {
        resize()
        if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
        draw()
    }

    resize()
    draw()
    window.addEventListener("resize", redraw)
    reducedMotion.addEventListener("change", redraw)

    return () => {
        if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
        window.removeEventListener("resize", redraw)
        reducedMotion.removeEventListener("change", redraw)
        disableKaizenRuntime()
        canvas.remove()
    }
}

export function enableNvidiaGeometry() {
    disableNvidiaGeometry()

    if (document.body) {
        cleanupGeometry = createGeometry()
        return
    }

    pendingStart = () => {
        pendingStart = null
        if (document.documentElement.dataset.theme === "nvidia") {
            cleanupGeometry = createGeometry()
        }
    }
    document.addEventListener("DOMContentLoaded", pendingStart, { once: true })
}

export function disableNvidiaGeometry() {
    if (pendingStart) {
        document.removeEventListener("DOMContentLoaded", pendingStart)
        pendingStart = null
    }
    cleanupGeometry?.()
    cleanupGeometry = null
}

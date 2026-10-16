const TRANSIENT_STATUSES = new Set([502, 503, 504])

export class SessionStartupTimeout extends Error {
    constructor() {
        super("The desktop did not become ready within 30 seconds. Please try connecting again.")
    }
}

export function isTransientStartupStatus(status: number): boolean {
    return TRANSIENT_STATUSES.has(status)
}

/** One deadline shared by readiness checks and the initial stream handshake. */
export class SessionStartup {
    private controller = new AbortController()
    private complete = false

    readonly deadline: number
    private retryDelay: number

    constructor(deadline = Date.now() + 30000, retryDelay = 1000) {
        this.deadline = deadline
        this.retryDelay = retryDelay
    }

    get active(): boolean {
        return !this.complete
    }

    get signal(): AbortSignal {
        return this.controller.signal
    }

    get remaining(): number {
        this.signal.throwIfAborted()
        const remaining = this.deadline - Date.now()
        if (remaining <= 0) throw new SessionStartupTimeout()
        return remaining
    }

    finish(): void {
        this.complete = true
    }

    cancel(): void {
        this.controller.abort()
    }

    async pause(): Promise<void> {
        const delay = Math.min(this.retryDelay, this.remaining)
        await new Promise<void>((resolve, reject) => {
            const abort = () => {
                clearTimeout(timer)
                reject(this.signal.reason)
            }
            const timer = setTimeout(() => {
                this.signal.removeEventListener("abort", abort)
                resolve()
            }, delay)
            this.signal.addEventListener("abort", abort, { once: true })
        })
        this.remaining
    }

    async withinBudget<T>(operation: () => Promise<T>): Promise<T> {
        const signal = AbortSignal.any([this.signal, AbortSignal.timeout(this.remaining)])
        return new Promise<T>((resolve, reject) => {
            const abort = () => reject(this.signal.aborted ? this.signal.reason : new SessionStartupTimeout())
            signal.addEventListener("abort", abort, { once: true })
            operation().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
        })
    }

    async fetch(input: RequestInfo | URL, init: RequestInit, retry = true): Promise<Response> {
        if (this.complete) return fetch(input, init)
        for (;;) {
            const signal = AbortSignal.any([
                this.signal,
                AbortSignal.timeout(Math.min(this.remaining, 12000)),
                ...(init.signal ? [init.signal] : []),
            ])
            try {
                const response = await fetch(input, { ...init, signal })
                if (!retry || !isTransientStartupStatus(response.status)) return response
                await response.body?.cancel()
            } catch (error) {
                this.signal.throwIfAborted()
                if (!retry || !(error instanceof TypeError || (error instanceof DOMException && error.name == "TimeoutError"))) throw error
            }
            await this.pause()
        }
    }
}

export class StreamedJsonResponse<Initial, Other> {
    response: Initial

    private reader
    private decoder = new TextDecoder()
    private bufferedText = ""

    constructor(body: ReadableStreamDefaultReader, response: Initial) {
        this.reader = body
        this.response = response
    }

    async next(): Promise<Other | null> {
        while (true) {
            const newline = this.bufferedText.indexOf("\n")
            if (newline >= 0) {
                const text = this.bufferedText.slice(0, newline)
                this.bufferedText = this.bufferedText.slice(newline + 1)
                return JSON.parse(text)
            }

            const { done, value } = await this.reader.read()
            if (done) {
                return null
            }

            this.bufferedText += this.decoder.decode(value, { stream: true })
        }
    }
}

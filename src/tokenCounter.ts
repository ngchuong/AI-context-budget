import type { Tiktoken } from "js-tiktoken/lite" with { "resolution-mode": "import" };

export class TokenCounter {
    private encoder?: Tiktoken;

    /** Resolve khi tokenizer đã nạp xong (hoặc nạp lỗi, khi đó dùng ước lượng). */
    public readonly ready: Promise<void>;

    constructor() {
        this.ready = this.load();
    }

    /**
     * Nạp tokenizer bằng dynamic import để webpack tách ra file riêng (dist/tokenizer.js, ~2MB),
     * giữ extension.js nhỏ. Chỉ nạp bảng o200k_base (GPT-4o) thay vì cả 6 bảng của js-tiktoken.
     */
    private async load(): Promise<void> {
        try {
            const [{ Tiktoken }, { default: o200kBase }] = await Promise.all([
                import(/* webpackChunkName: "tokenizer" */ "js-tiktoken/lite"),
                import(/* webpackChunkName: "tokenizer" */ "js-tiktoken/ranks/o200k_base"),
            ]);
            this.encoder = new Tiktoken(o200kBase);
        } catch (error) {
            console.error('[ai-context-budget] Không nạp được tokenizer, dùng ước lượng ~4 ký tự/token', error);
        }
    }

    public count(text: string): number {
        if (!text) { return 0; }
        if (!this.encoder) {
            // Tokenizer chưa nạp xong: ước lượng ~4 ký tự = 1 token
            return Math.ceil(text.length / 4);
        }
        try {
            return this.encoder.encode(text).length;
        } catch (error) {
            // Fallback đơn giản nếu file quá lớn hoặc lỗi mã hóa: ~4 ký tự = 1 token
            return Math.ceil(text.length / 4);
        }
    }
}

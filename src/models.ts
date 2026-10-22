import * as vscode from 'vscode';

export interface ModelPricing {
    id: string;              // OpenRouter id, ví dụ "anthropic/claude-sonnet-5.5"
    name: string;
    provider: string;
    inputPricePerM: number;  // USD per 1M tokens
    outputPricePerM: number; // USD per 1M tokens
    maxContext: number;
    created: number;         // unix seconds, dùng để tìm model mới nhất
}

export interface CatalogInfo {
    source: 'live' | 'cache' | 'fallback';
    fetchedAt?: number;      // ms
    error?: string;
}

const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_KEY = 'aiContextBudget.modelCatalog';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

// Khi không chọn model nào trong Settings, lấy bản mới nhất của từng dòng model này
// (GPT bản thường / Claude Sonnet / Gemini Flash), để tự cập nhật khi có phiên bản mới
const AUTO_PICKS: { provider: string; include?: RegExp; exclude?: RegExp }[] = [
    { provider: 'openai', include: /^openai\/gpt-\d/, exclude: /-(pro|mini|nano|chat|audio|search|codex|oss)\b/ },
    { provider: 'anthropic', include: /sonnet/ },
    { provider: 'google', include: /flash/, exclude: /lite|image|banana/ },
];

// Chỉ dùng khi chưa từng tải được bảng giá (offline lần đầu). Giá theo OpenRouter 10/2026.
const FALLBACK_MODELS: ModelPricing[] = [
    { id: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol', provider: 'openai', inputPricePerM: 2, outputPricePerM: 10, maxContext: 1_050_000, created: 0 },
    { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', provider: 'anthropic', inputPricePerM: 2, outputPricePerM: 10, maxContext: 1_000_000, created: 0 },
    { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', provider: 'google', inputPricePerM: 0.825, outputPricePerM: 3.3, maxContext: 1_048_576, created: 0 },
];

interface CachedCatalog {
    fetchedAt: number;
    models: ModelPricing[];
}

interface OpenRouterModel {
    id: string;
    name: string;
    created: number;
    context_length: number | null;
    pricing: { prompt: string; completion: string };
    architecture?: { output_modalities?: string[] };
}

export function estimateCost(tokens: number, model: ModelPricing): number {
    return (tokens / 1_000_000) * model.inputPricePerM;
}

/** Danh sách model + giá lấy động từ OpenRouter, có cache trong globalState. */
export class ModelRegistry {
    private catalog: ModelPricing[];
    private info: CatalogInfo;
    private refreshing?: Promise<void>;

    private readonly changeEmitter = new vscode.EventEmitter<void>();
    public readonly onDidChange = this.changeEmitter.event;

    constructor(private readonly state: vscode.Memento) {
        const cached = state.get<CachedCatalog>(CACHE_KEY);
        if (cached?.models.length) {
            this.catalog = cached.models;
            this.info = { source: 'cache', fetchedAt: cached.fetchedAt };
        } else {
            this.catalog = FALLBACK_MODELS;
            this.info = { source: 'fallback' };
        }
    }

    public getCatalog(): ModelPricing[] {
        return this.catalog;
    }

    public getInfo(): CatalogInfo {
        return this.info;
    }

    /** Model dùng để so sánh: theo Settings, nếu trống thì tự chọn model mới nhất của mỗi hãng. */
    public getSelected(): ModelPricing[] {
        const ids = vscode.workspace.getConfiguration('aiContextBudget').get<string[]>('models', []);
        const byId = new Map(this.catalog.map(m => [m.id, m]));
        const picked = ids.map(id => byId.get(id)).filter((m): m is ModelPricing => !!m);
        return picked.length ? picked : this.pickLatest();
    }

    /** Model chính, dùng cho status bar. */
    public getPrimary(): ModelPricing {
        return this.getSelected()[0] ?? FALLBACK_MODELS[0];
    }

    /** Tải lại bảng giá nếu cache đã cũ (hoặc luôn tải khi force = true). */
    public refresh(force = false): Promise<void> {
        const fresh = this.info.fetchedAt && Date.now() - this.info.fetchedAt < CACHE_TTL_MS;
        if (!force && fresh) { return Promise.resolve(); }

        this.refreshing ??= this.fetchCatalog().finally(() => { this.refreshing = undefined; });
        return this.refreshing;
    }

    private async fetchCatalog(): Promise<void> {
        try {
            const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
            if (!res.ok) { throw new Error(`HTTP ${res.status}`); }

            const body = await res.json() as { data: OpenRouterModel[] };
            const models = body.data.map(toModelPricing).filter((m): m is ModelPricing => !!m);
            if (!models.length) { throw new Error('Empty model list'); }

            const fetchedAt = Date.now();
            this.catalog = models;
            this.info = { source: 'live', fetchedAt };
            await this.state.update(CACHE_KEY, { fetchedAt, models } satisfies CachedCatalog);
        } catch (err) {
            // Giữ nguyên dữ liệu cache/fallback hiện có, chỉ ghi lại lỗi để hiển thị
            this.info = { ...this.info, error: err instanceof Error ? err.message : String(err) };
        }
        this.changeEmitter.fire();
    }

    private pickLatest(): ModelPricing[] {
        const newest = (models: ModelPricing[]) =>
            [...models].sort((a, b) => b.created - a.created || a.id.length - b.id.length)[0];

        return AUTO_PICKS
            .map(({ provider, include, exclude }) => {
                const ofProvider = this.catalog.filter(m => m.provider === provider);
                const inFamily = ofProvider.filter(m =>
                    (!include || include.test(m.id)) && (!exclude || !exclude.test(m.id)));
                // Nếu hãng đổi cách đặt tên, vẫn lấy model mới nhất của hãng đó
                return newest(inFamily) ?? newest(ofProvider);
            })
            .filter((m): m is ModelPricing => !!m);
    }
}

/** Giá/token -> giá/1M token, làm tròn để tránh sai số float (0.0999999...). */
function perMillion(pricePerToken: number): number {
    return Math.round(pricePerToken * 1e12) / 1e6;
}

function toModelPricing(m: OpenRouterModel): ModelPricing | undefined {
    // Bỏ biến thể (":free", ":batch"...), model không sinh text, model không có giá cố định
    if (m.id.includes(':')) { return undefined; }
    const outputs = m.architecture?.output_modalities ?? ['text'];
    if (outputs.length !== 1 || outputs[0] !== 'text') { return undefined; }

    const input = Number(m.pricing?.prompt);
    const output = Number(m.pricing?.completion);
    if (!Number.isFinite(input) || input < 0 || !m.context_length) { return undefined; }

    const provider = m.id.split('/')[0];
    return {
        id: m.id,
        // "Anthropic: Claude Sonnet 5.5" -> "Claude Sonnet 5.5" cho gọn trong sidebar
        name: m.name.includes(': ') ? m.name.slice(m.name.indexOf(': ') + 2) : m.name,
        provider,
        inputPricePerM: perMillion(input),
        outputPricePerM: Number.isFinite(output) && output >= 0 ? perMillion(output) : 0,
        maxContext: m.context_length,
        created: m.created ?? 0,
    };
}

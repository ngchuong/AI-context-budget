import * as vscode from 'vscode';
import { ModelRegistry } from './models';

export interface ContextSnapshot {
    source: string;          // ví dụ: "Active file: src/a.ts", "Workspace", "Selection (3 files)"
    totalTokens: number;
    fileCount?: number;
    topFiles?: { path: string; tokens: number }[];
}

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'aiContextBudget.panel';

    private view?: vscode.WebviewView;
    private snapshot: ContextSnapshot = { source: 'No data yet', totalTokens: 0 };

    constructor(private readonly registry: ModelRegistry) { }

    public resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();

        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg?.type === 'ready') {
                this.postSnapshot();
            } else if (msg?.type === 'command') {
                const allowed = ['aiContextBudget.analyzeWorkspace', 'aiContextBudget.selectModels', 'aiContextBudget.refreshPrices'];
                if (allowed.includes(msg.command)) {
                    vscode.commands.executeCommand(msg.command);
                }
            }
        });
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) { this.postSnapshot(); }
        });
    }

    public update(snapshot: ContextSnapshot): void {
        this.snapshot = snapshot;
        this.postSnapshot();
    }

    /** Gửi lại dữ liệu khi đổi Settings hoặc bảng giá vừa được tải lại. */
    public refresh(): void {
        this.postSnapshot();
    }

    private postSnapshot(): void {
        if (!this.view) { return; }
        const config = vscode.workspace.getConfiguration('aiContextBudget');
        this.view.webview.postMessage({
            type: 'update',
            snapshot: this.snapshot,
            models: this.registry.getSelected(),
            catalog: this.registry.getInfo(),
            thresholds: {
                warning: config.get<number>('warningThreshold', 30000),
                danger: config.get<number>('dangerThreshold', 100000),
            },
        });
    }

    private getHtml(): string {
        const nonce = getNonce();
        const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    :root {
        --green: #3fb950;
        --yellow: #d29922;
        --red: #f85149;
    }
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 12px 12px; }
    h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin: 16px 0 6px; }
    .source { color: var(--vscode-descriptionForeground); word-break: break-all; }
    .total { font-size: 22px; font-weight: 600; margin: 4px 0; font-variant-numeric: tabular-nums; }
    .zone { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; color: #fff; }
    .zone.green { background: var(--green); }
    .zone.yellow { background: var(--yellow); }
    .zone.red { background: var(--red); }

    input[type=range] { width: 100%; -webkit-appearance: none; appearance: none; height: 8px; border-radius: 4px; outline: none; margin: 10px 0 4px; }
    input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: var(--vscode-foreground); border: 2px solid var(--vscode-editor-background); cursor: pointer; }
    .scale { display: flex; justify-content: space-between; font-size: 10px; color: var(--vscode-descriptionForeground); }
    .what-if { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; font-size: 12px; }

    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    th, td { text-align: left; padding: 5px 4px; border-bottom: 1px solid var(--vscode-panel-border); }
    th { font-weight: 600; font-size: 11px; color: var(--vscode-descriptionForeground); }
    td.num, th.num { text-align: right; }
    .bar { height: 4px; background: var(--vscode-editorWidget-border, #444); border-radius: 2px; margin-top: 3px; overflow: hidden; }
    .bar > div { height: 100%; }
    .over { color: var(--red); font-weight: 600; }

    ul.files { list-style: none; padding: 0; margin: 0; }
    ul.files li { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
    ul.files .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    ul.files .num { color: var(--vscode-descriptionForeground); flex-shrink: 0; font-variant-numeric: tabular-nums; }

    button { margin-top: 14px; width: 100%; padding: 6px; border: none; border-radius: 2px; cursor: pointer;
        background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.link { width: auto; margin: 0; padding: 0 4px; background: none; color: var(--vscode-textLink-foreground); }
    .catalog { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 6px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .catalog.error { color: var(--yellow); }
    .hidden { display: none; }
</style>
</head>
<body>
    <h3>Context</h3>
    <div class="source" id="source"></div>
    <div class="total"><span id="total">0</span> tokens <span class="zone green" id="zone">Safe</span></div>
    <div class="source" id="fileCount"></div>

    <h3>Context Limit Warning</h3>
    <input type="range" id="slider" min="0" max="150000" step="500" value="0">
    <div class="scale"><span>0</span><span id="warnLabel"></span><span id="dangerLabel"></span><span id="maxLabel"></span></div>
    <div class="what-if">
        <span id="whatIfText"></span>
        <button class="link hidden" id="reset">Reset</button>
    </div>

    <h3>Cost Comparison (input)</h3>
    <table>
        <thead><tr><th>Model</th><th class="num">Cost</th><th class="num">Window</th></tr></thead>
        <tbody id="models"></tbody>
    </table>
    <div class="catalog">
        <span id="catalogInfo"></span>
        <span>
            <button class="link" data-command="aiContextBudget.selectModels">Models</button>
            <button class="link" data-command="aiContextBudget.refreshPrices">Refresh</button>
        </span>
    </div>

    <div id="topFilesSection" class="hidden">
        <h3>Largest Files</h3>
        <ul class="files" id="topFiles"></ul>
    </div>

    <button data-command="aiContextBudget.analyzeWorkspace">Analyze Workspace</button>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    let state = null;
    let actualTokens = 0;

    const fmt = n => n.toLocaleString('en-US');
    const short = n => n >= 1e6 ? (n / 1e6) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
    const money = n => n === 0 ? '$0' : n < 0.01 ? '$' + n.toFixed(4) : '$' + n.toFixed(2);
    const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function zoneOf(tokens) {
        const { warning, danger } = state.thresholds;
        if (tokens > danger) return { cls: 'red', label: 'Too large' };
        if (tokens >= warning) return { cls: 'yellow', label: 'Warning' };
        return { cls: 'green', label: 'Safe' };
    }

    function render(tokens) {
        const { warning, danger } = state.thresholds;
        const slider = $('slider');
        const max = Math.max(danger * 1.5, actualTokens * 1.1);
        slider.max = String(Math.ceil(max / 1000) * 1000);
        const w = warning / slider.max * 100, d = danger / slider.max * 100;
        slider.style.background = 'linear-gradient(to right, var(--green) 0%, var(--green) ' + w + '%, var(--yellow) ' + w + '%, var(--yellow) ' + d + '%, var(--red) ' + d + '%, var(--red) 100%)';
        slider.value = String(tokens);

        $('warnLabel').textContent = short(warning);
        $('dangerLabel').textContent = short(danger);
        $('maxLabel').textContent = short(Number(slider.max));

        const zone = zoneOf(tokens);
        $('zone').className = 'zone ' + zone.cls;
        $('zone').textContent = zone.label;

        const isWhatIf = tokens !== actualTokens;
        $('whatIfText').textContent = isWhatIf ? 'What-if: ' + fmt(tokens) + ' tokens' : 'Drag to estimate other sizes';
        $('reset').classList.toggle('hidden', !isWhatIf);

        $('models').innerHTML = state.models.map(m => {
            const cost = tokens / 1e6 * m.inputPricePerM;
            const pct = tokens / m.maxContext * 100;
            const color = pct > 100 ? 'var(--red)' : pct > 75 ? 'var(--yellow)' : 'var(--green)';
            const priceTip = escapeHtml(m.id) + ' — in $' + m.inputPricePerM.toFixed(3) + '/M · out $' + m.outputPricePerM.toFixed(3) + '/M';
            return '<tr><td title="' + priceTip + '">' + escapeHtml(m.name) +
                '<div class="bar"><div style="width:' + Math.min(pct, 100) + '%;background:' + color + '"></div></div></td>' +
                '<td class="num">' + money(cost) + '</td>' +
                '<td class="num' + (pct > 100 ? ' over' : '') + '">' + pct.toFixed(pct < 10 ? 1 : 0) + '% of ' + short(m.maxContext) + '</td></tr>';
        }).join('');
    }

    window.addEventListener('message', e => {
        if (e.data.type !== 'update') return;
        state = e.data;
        const s = state.snapshot;
        actualTokens = s.totalTokens;
        $('source').textContent = s.source;
        $('total').textContent = fmt(s.totalTokens);
        $('fileCount').textContent = s.fileCount ? s.fileCount + ' files' : '';

        const top = s.topFiles || [];
        $('topFilesSection').classList.toggle('hidden', top.length === 0);
        $('topFiles').innerHTML = top.map(f =>
            '<li><span class="path" title="' + escapeHtml(f.path) + '">' + escapeHtml(f.path) + '</span><span class="num">' + fmt(f.tokens) + '</span></li>'
        ).join('');

        renderCatalog(state.catalog);
        render(actualTokens);
    });

    function renderCatalog(info) {
        const el = $('catalogInfo');
        const age = info.fetchedAt ? timeAgo(info.fetchedAt) : '';
        el.textContent = info.source === 'fallback'
            ? 'Offline prices (built-in)'
            : 'OpenRouter prices · ' + age;
        el.title = info.error ? 'Last refresh failed: ' + info.error : '';
        el.parentElement.classList.toggle('error', !!info.error);
        if (info.error) el.textContent += ' ⚠';
    }

    function timeAgo(ms) {
        const min = Math.round((Date.now() - ms) / 60000);
        if (min < 1) return 'just now';
        if (min < 60) return min + 'm ago';
        const h = Math.round(min / 60);
        return h < 24 ? h + 'h ago' : Math.round(h / 24) + 'd ago';
    }

    $('slider').addEventListener('input', e => state && render(Number(e.target.value)));
    $('reset').addEventListener('click', () => render(actualTokens));
    document.querySelectorAll('[data-command]').forEach(btn =>
        btn.addEventListener('click', () => vscode.postMessage({ type: 'command', command: btn.dataset.command })));

    vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 32; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

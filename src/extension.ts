import * as vscode from 'vscode';
import { TokenCounter } from './tokenCounter';
import { ModelRegistry, estimateCost } from './models';
import { collectFiles, formatAsPrompt, CollectedFile } from './fileCollector';
import { SidebarProvider, ContextSnapshot } from './sidebarProvider';

let statusBarItem: vscode.StatusBarItem;
let sidebar: SidebarProvider;
let registry: ModelRegistry;
// true khi sidebar đang hiển thị kết quả phân tích workspace/selection,
// để việc gõ phím trong editor không ghi đè kết quả đó
let showingAnalysis = false;
const tokenCounter = new TokenCounter();

export function activate(context: vscode.ExtensionContext) {
	// Tạo item ở thanh trạng thái dưới cùng (bên phải)
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'aiContextBudget.panel.focus';
	context.subscriptions.push(statusBarItem);

	registry = new ModelRegistry(context.globalState);
	sidebar = new SidebarProvider(registry);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aiContextBudget.analyzeWorkspace', analyzeWorkspace),
		vscode.commands.registerCommand('aiContextBudget.calculateCost', calculateCost),
		vscode.commands.registerCommand('aiContextBudget.copyAsPrompt', copyAsPrompt),
		vscode.commands.registerCommand('aiContextBudget.selectModels', selectModels),
		vscode.commands.registerCommand('aiContextBudget.refreshPrices', refreshPrices),
		registry.onDidChange(() => {
			sidebar.refresh();
			updateStatusBar();
		})
	);

	// Lắng nghe sự kiện đổi tab hoặc sửa nội dung file
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => {
			showingAnalysis = false;
			updateStatusBar();
		}),
		vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document === vscode.window.activeTextEditor?.document) {
				updateStatusBar();
			}
		}),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('aiContextBudget')) {
				sidebar.refresh();
				updateStatusBar();
			}
		})
	);

	updateStatusBar();
	// Tokenizer nạp bất đồng bộ; trước đó status bar hiển thị số ước lượng
	tokenCounter.ready.then(updateStatusBar);
	// Tải bảng giá mới ở nền (bỏ qua nếu cache còn hạn 24h)
	registry.refresh();
}

function updateStatusBar() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		statusBarItem.hide();
		return;
	}

	const text = editor.document.getText();
	const tokens = tokenCounter.count(text);

	// Tính chi phí ước tính cho model chính (model đầu tiên trong danh sách so sánh)
	const model = registry.getPrimary();
	const cost = estimateCost(tokens, model);

	statusBarItem.text = `$(symbol-keyword) ${tokens.toLocaleString()} tokens (~$${cost.toFixed(4)})`;
	statusBarItem.tooltip = `File context length: ${tokens} tokens\nModel: ${model.name} ($${model.inputPricePerM}/1M input)\nClick to open AI Context Budget panel`;
	statusBarItem.show();

	if (!showingAnalysis) {
		sidebar.update({
			source: `Active file: ${vscode.workspace.asRelativePath(editor.document.uri, false)}`,
			totalTokens: tokens,
		});
	}
}

async function analyzeWorkspace() {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		vscode.window.showWarningMessage('AI Context Budget: Không có workspace nào đang mở.');
		return;
	}

	const result = await analyze(folders.map(f => f.uri), 'Workspace');
	if (!result) { return; }

	const { snapshot } = result;
	const exceeded = registry.getSelected()
		.filter(m => snapshot.totalTokens > m.maxContext)
		.map(m => `${m.name} (${m.maxContext.toLocaleString()})`);

	const summary = `Workspace: ${snapshot.totalTokens.toLocaleString()} tokens trong ${snapshot.fileCount} file.`;
	if (exceeded.length) {
		vscode.window.showWarningMessage(`${summary} Vượt context window của: ${exceeded.join(', ')}.`);
	} else {
		vscode.window.showInformationMessage(`${summary} Vừa với context window của tất cả model.`);
	}
}

/** Lệnh chuột phải trong Explorer: tính token + chi phí cho các file/folder được chọn. */
async function calculateCost(uri?: vscode.Uri, uris?: vscode.Uri[]) {
	const targets = resolveTargets(uri, uris);
	if (!targets.length) { return; }

	const result = await analyze(targets, selectionLabel(targets));
	if (!result) { return; }

	const { snapshot } = result;
	const costs = registry.getSelected()
		.map(m => `${m.name}: $${estimateCost(snapshot.totalTokens, m).toFixed(4)}`)
		.join(' · ');
	vscode.window.showInformationMessage(
		`${snapshot.totalTokens.toLocaleString()} tokens (${snapshot.fileCount} file) — ${costs}`
	);
}

/** Lệnh chuột phải trong Explorer: gom file thành context cho prompt và copy vào clipboard. */
async function copyAsPrompt(uri?: vscode.Uri, uris?: vscode.Uri[]) {
	const targets = resolveTargets(uri, uris);
	if (!targets.length) { return; }

	const result = await analyze(targets, selectionLabel(targets));
	if (!result) { return; }
	if (!result.files.length) {
		vscode.window.showWarningMessage('AI Context Budget: Không có file text nào để copy.');
		return;
	}

	const prompt = formatAsPrompt(result.files);
	await vscode.env.clipboard.writeText(prompt);

	// Đếm lại trên chuỗi cuối cùng vì phần bọc <file> và ``` cũng tốn token
	const promptTokens = tokenCounter.count(prompt);
	vscode.window.showInformationMessage(
		`Đã copy ${result.files.length} file vào clipboard (${promptTokens.toLocaleString()} tokens).`
	);
}

/** Cho người dùng chọn model để so sánh từ bảng giá OpenRouter mới nhất. */
async function selectModels() {
	await registry.refresh();
	const selectedIds = new Set(registry.getSelected().map(m => m.id));

	const items = [...registry.getCatalog()]
		.sort((a, b) => a.provider.localeCompare(b.provider) || b.created - a.created)
		.map(m => ({
			label: m.name,
			description: m.id,
			detail: `$${m.inputPricePerM}/1M input · $${m.outputPricePerM}/1M output · ${m.maxContext.toLocaleString()} tokens context`,
			picked: selectedIds.has(m.id),
			id: m.id,
		}));

	const picked = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		matchOnDescription: true,
		placeHolder: 'Chọn model để so sánh (model đầu tiên dùng cho status bar). Bỏ chọn hết = tự lấy model mới nhất.',
	});
	if (!picked) { return; }

	// Giữ thứ tự cũ cho các model đã chọn trước đó, model mới thêm vào cuối
	const previous = [...selectedIds].filter(id => picked.some(p => p.id === id));
	const added = picked.map(p => p.id).filter(id => !selectedIds.has(id));
	await vscode.workspace.getConfiguration('aiContextBudget')
		.update('models', [...previous, ...added], vscode.ConfigurationTarget.Global);
}

async function refreshPrices() {
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'AI Context Budget: Đang tải bảng giá...' },
		() => registry.refresh(true)
	);
	const info = registry.getInfo();
	if (info.error) {
		vscode.window.showWarningMessage(`Không tải được bảng giá (${info.error}). Đang dùng dữ liệu đã lưu.`);
	} else {
		vscode.window.showInformationMessage(`Đã cập nhật giá cho ${registry.getCatalog().length} model từ OpenRouter.`);
	}
}

/** Gom file, đếm token từng file, cập nhật sidebar. Trả về undefined nếu người dùng huỷ. */
async function analyze(
	targets: vscode.Uri[],
	source: string
): Promise<{ files: CollectedFile[]; snapshot: ContextSnapshot } | undefined> {
	return vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'AI Context Budget',
			cancellable: true,
		},
		async (progress, token) => {
			progress.report({ message: 'Đang quét file...' });
			const files = await collectFiles(targets, token);
			await tokenCounter.ready;

			const perFile: { path: string; tokens: number }[] = [];
			let total = 0;
			for (let i = 0; i < files.length; i++) {
				if (token.isCancellationRequested) { return undefined; }

				const tokens = tokenCounter.count(files[i].content);
				perFile.push({ path: files[i].relativePath, tokens });
				total += tokens;

				// Nhường event loop định kỳ để VS Code không bị đơ khi project lớn
				if (i % 20 === 0) {
					progress.report({ message: `Đang đếm token ${i + 1}/${files.length}...` });
					await new Promise(resolve => setImmediate(resolve));
				}
			}
			if (token.isCancellationRequested) { return undefined; }

			perFile.sort((a, b) => b.tokens - a.tokens);
			const snapshot: ContextSnapshot = {
				source,
				totalTokens: total,
				fileCount: files.length,
				topFiles: perFile.slice(0, 10),
			};
			showingAnalysis = true;
			sidebar.update(snapshot);
			return { files, snapshot };
		}
	);
}

function resolveTargets(uri?: vscode.Uri, uris?: vscode.Uri[]): vscode.Uri[] {
	// Explorer truyền uris khi chọn nhiều item; khi gọi từ Command Palette thì dùng file đang mở
	if (uris?.length) { return uris; }
	if (uri) { return [uri]; }
	const active = vscode.window.activeTextEditor?.document.uri;
	return active ? [active] : [];
}

function selectionLabel(targets: vscode.Uri[]): string {
	return targets.length === 1
		? `Selection: ${vscode.workspace.asRelativePath(targets[0], false)}`
		: `Selection: ${targets.length} items`;
}

export function deactivate() { }

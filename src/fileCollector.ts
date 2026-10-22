import * as vscode from 'vscode';
import * as path from 'path';
import ignore, { Ignore } from 'ignore';

// Luôn bỏ qua các thư mục này, kể cả khi project không có .gitignore
const ALWAYS_EXCLUDED = ['node_modules/', '.git/', 'dist/', 'out/', '.vscode-test/'];

// Bỏ qua file quá lớn (thường là file sinh tự động / dữ liệu), tránh treo extension host
const MAX_FILE_BYTES = 1024 * 1024;

export interface CollectedFile {
    uri: vscode.Uri;
    relativePath: string;
    content: string;
}

interface IgnoreScope {
    dir: string; // đường dẫn tuyệt đối của thư mục chứa .gitignore
    matcher: Ignore;
}

/**
 * Gom tất cả file text từ danh sách URI (file hoặc folder), tôn trọng .gitignore
 * ở thư mục gốc workspace và các thư mục con.
 */
export async function collectFiles(
    uris: vscode.Uri[],
    token?: vscode.CancellationToken
): Promise<CollectedFile[]> {
    const result: CollectedFile[] = [];
    const seen = new Set<string>();

    for (const uri of uris) {
        const stat = await vscode.workspace.fs.stat(uri);
        const scopes = await loadAncestorScopes(uri);

        if (stat.type & vscode.FileType.Directory) {
            await walkDirectory(uri, scopes, result, seen, token);
        } else {
            // File được chọn trực tiếp thì luôn lấy, không áp dụng .gitignore
            await addFile(uri, result, seen);
        }
    }

    return result;
}

async function walkDirectory(
    dirUri: vscode.Uri,
    parentScopes: IgnoreScope[],
    result: CollectedFile[],
    seen: Set<string>,
    token?: vscode.CancellationToken
): Promise<void> {
    if (token?.isCancellationRequested) { return; }

    const scopes = [...parentScopes];
    const own = await loadGitignore(dirUri);
    if (own) { scopes.push(own); }

    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
        return;
    }

    for (const [name, type] of entries) {
        const childUri = vscode.Uri.joinPath(dirUri, name);
        const isDir = (type & vscode.FileType.Directory) !== 0;

        if (isIgnored(childUri.fsPath, isDir, scopes)) { continue; }

        if (isDir) {
            await walkDirectory(childUri, scopes, result, seen, token);
        } else if (type & vscode.FileType.File) {
            await addFile(childUri, result, seen);
        }
    }
}

async function addFile(uri: vscode.Uri, result: CollectedFile[], seen: Set<string>): Promise<void> {
    if (seen.has(uri.fsPath)) { return; }
    seen.add(uri.fsPath);

    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_BYTES) { return; }

        const bytes = await vscode.workspace.fs.readFile(uri);
        if (isBinary(bytes)) { return; }

        result.push({
            uri,
            relativePath: vscode.workspace.asRelativePath(uri, false),
            content: Buffer.from(bytes).toString('utf8'),
        });
    } catch {
        // File không đọc được (quyền, symlink hỏng...) thì bỏ qua
    }
}

function isIgnored(fsPath: string, isDir: boolean, scopes: IgnoreScope[]): boolean {
    for (const scope of scopes) {
        const rel = path.relative(scope.dir, fsPath).split(path.sep).join('/');
        if (!rel || rel.startsWith('..')) { continue; }
        if (scope.matcher.ignores(isDir ? `${rel}/` : rel)) { return true; }
    }
    return false;
}

/**
 * Khi người dùng chọn 1 folder con, vẫn phải áp dụng .gitignore của các thư mục cha
 * (từ gốc workspace xuống tới folder đó).
 */
async function loadAncestorScopes(uri: vscode.Uri): Promise<IgnoreScope[]> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const rootDir = folder?.uri.fsPath ?? path.dirname(uri.fsPath);

    const scopes: IgnoreScope[] = [{ dir: rootDir, matcher: ignore().add(ALWAYS_EXCLUDED) }];
    if (!folder) { return scopes; }

    // Danh sách thư mục cha từ gốc tới (không gồm) uri; walkDirectory tự load .gitignore của chính nó
    const ancestors: string[] = [];
    let current = path.dirname(uri.fsPath);
    while (current.startsWith(rootDir)) {
        ancestors.unshift(current);
        if (current === rootDir) { break; }
        current = path.dirname(current);
    }

    for (const dir of ancestors) {
        const scope = await loadGitignore(vscode.Uri.file(dir));
        if (scope) { scopes.push(scope); }
    }
    return scopes;
}

async function loadGitignore(dirUri: vscode.Uri): Promise<IgnoreScope | undefined> {
    try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dirUri, '.gitignore'));
        return { dir: dirUri.fsPath, matcher: ignore().add(Buffer.from(bytes).toString('utf8')) };
    } catch {
        return undefined;
    }
}

function isBinary(bytes: Uint8Array): boolean {
    const len = Math.min(bytes.length, 8000);
    for (let i = 0; i < len; i++) {
        if (bytes[i] === 0) { return true; }
    }
    return false;
}

/** Định dạng danh sách file thành context cho prompt AI. */
export function formatAsPrompt(files: CollectedFile[]): string {
    return files.map(f => {
        const lang = path.extname(f.relativePath).slice(1);
        // Dùng fence dài hơn mọi chuỗi ``` có trong nội dung để không bị vỡ markdown
        const longestRun = Math.max(2, ...(f.content.match(/`+/g) ?? []).map(m => m.length));
        const fence = '`'.repeat(longestRun + 1);
        const body = f.content.endsWith('\n') ? f.content : `${f.content}\n`;
        return `<file path="${f.relativePath}">\n${fence}${lang}\n${body}${fence}\n</file>`;
    }).join('\n\n') + '\n';
}

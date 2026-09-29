import {
	Bash,
	type FileContent,
	type FsStat,
	type IFileSystem,
} from 'just-bash/browser';
import type { AccountFiles, FileSnapshot } from './files.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function absolute(base: string, path: string): string {
	const parts = (path.startsWith('/') ? path : `${base}/${path}`).split('/');
	const resolved: string[] = [];
	for (const part of parts) {
		if (!part || part === '.') continue;
		if (part === '..') resolved.pop();
		else resolved.push(part);
	}
	return `/${resolved.join('/')}`;
}

function bytes(content: FileContent): Uint8Array {
	return typeof content === 'string'
		? encoder.encode(content)
		: new Uint8Array(content);
}

function unavailable(): never {
	throw new Error(
		'This demo shell supports reading and saving files; this operation is not available',
	);
}

export function openBrowserShell(files: AccountFiles, account = 'demo') {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(account))
		throw new Error('Invalid account folder name');
	const shellRoot = `/Epicenter/accounts/${account}`;
	let revisions = new Map<string, FileSnapshot>();
	let commandStart = new Map<string, FileSnapshot>();
	let visiblePaths: string[] = [];
	let queue = Promise.resolve();
	const within = (path: string): string => {
		const full = absolute(shellRoot, path);
		if (!full.startsWith(`${shellRoot}/`))
			throw new Error('Path is outside the selected account folder');
		return full.slice(shellRoot.length + 1);
	};
	const pathFor = (path: string) => `${shellRoot}/${path}`;
	const directory = (path: string) =>
		path === shellRoot ||
		path === '/' ||
		path === '/Epicenter' ||
		path === '/Epicenter/accounts' ||
		visiblePaths.some((file) => pathFor(file).startsWith(`${path}/`));
	const current = async (path: string) => {
		const source = await files.read(within(path));
		if (!source) throw new Error(`No such file: ${path}`);
		if (!revisions.has(source.path)) revisions.set(source.path, source);
		return source;
	};
	const write = async (path: string, content: FileContent) => {
		const name = within(path);
		const previous = revisions.get(name) ?? commandStart.get(name);
		const next = previous
			? await files.replace(previous, bytes(content))
			: await files.create(name, bytes(content));
		revisions.set(name, next);
		if (!visiblePaths.includes(name)) visiblePaths.push(name);
	};
	const fs: IFileSystem = {
		async readFile(path) {
			return decoder.decode((await current(path)).bytes);
		},
		async readFileBuffer(path) {
			return new Uint8Array((await current(path)).bytes);
		},
		async writeFile(path, content) {
			await write(path, content);
		},
		async appendFile(path, content) {
			const source = await files.read(within(path));
			if (!source) return write(path, content);
			if (!revisions.has(source.path)) revisions.set(source.path, source);
			const addition = bytes(content);
			const combined = new Uint8Array(source.bytes.length + addition.length);
			combined.set(source.bytes);
			combined.set(addition, source.bytes.length);
			await write(path, combined);
		},
		async exists(path) {
			if (directory(absolute(shellRoot, path))) return true;
			try {
				return !!(await files.read(within(path)));
			} catch {
				return false;
			}
		},
		async stat(path): Promise<FsStat> {
			const full = absolute(shellRoot, path);
			if (directory(full))
				return {
					isFile: false,
					isDirectory: true,
					isSymbolicLink: false,
					mode: 0o755,
					size: 0,
					mtime: new Date(),
				};
			const source = await current(path);
			return {
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false,
				mode: 0o644,
				size: source.bytes.length,
				mtime: new Date(),
			};
		},
		async mkdir(path) {
			const full = absolute(shellRoot, path);
			if (full !== shellRoot && !full.startsWith(`${shellRoot}/`))
				throw new Error('Path is outside the selected account folder');
		},
		async readdir(path) {
			const full = absolute(shellRoot, path);
			if (!directory(full)) throw new Error(`No such directory: ${path}`);
			const prefix = full === '/' ? '/' : `${full}/`;
			const children = new Set<string>();
			if (full === '/') children.add('Epicenter');
			if (full === '/Epicenter') children.add('accounts');
			if (full === '/Epicenter/accounts') children.add(account);
			for (const file of visiblePaths) {
				const fullPath = pathFor(file);
				if (fullPath.startsWith(prefix))
					children.add(fullPath.slice(prefix.length).split('/')[0] ?? '');
			}
			return [...children].filter(Boolean).sort();
		},
		async rm() {
			unavailable();
		},
		async cp(source, destination) {
			await write(destination, (await current(source)).bytes);
		},
		async mv() {
			unavailable();
		},
		resolvePath: absolute,
		getAllPaths() {
			return visiblePaths.map(pathFor);
		},
		async chmod() {
			unavailable();
		},
		async symlink() {
			unavailable();
		},
		async link() {
			unavailable();
		},
		async readlink() {
			unavailable();
		},
		async lstat(path) {
			return this.stat(path);
		},
		async realpath(path) {
			if (!(await this.exists(path))) throw new Error(`No such path: ${path}`);
			return absolute(shellRoot, path);
		},
		async utimes() {
			unavailable();
		},
	};
	const bash = new Bash({
		fs,
		cwd: shellRoot,
		commands: [
			'cat',
			'ls',
			'pwd',
			'find',
			'grep',
			'sed',
			'printf',
			'echo',
			'base64',
			'stat',
			'tree',
			'head',
			'tail',
			'wc',
		],
	});
	return {
		async exec(command: string) {
			const run = async () => {
				const snapshot = await files.snapshot();
				revisions = new Map();
				commandStart = new Map(snapshot.map((file) => [file.path, file]));
				visiblePaths = snapshot.map((file) => file.path);
				return bash.exec(command);
			};
			const next = queue.then(run, run);
			queue = next.then(
				() => {},
				() => {},
			);
			return next;
		},
	};
}

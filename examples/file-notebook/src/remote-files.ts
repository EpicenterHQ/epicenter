import type { AccountFiles, FileSnapshot } from './files.js';

type WireFile = { path: string; bytes: string; revision: string };

function encode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function decode(file: WireFile): FileSnapshot {
	return {
		path: file.path,
		revision: file.revision,
		bytes: Uint8Array.from(atob(file.bytes), (character) =>
			character.charCodeAt(0),
		),
	};
}

async function call<T>(operation: string, input?: unknown): Promise<T> {
	const response = await fetch(
		`/api/${operation}`,
		input === undefined
			? undefined
			: {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(input),
				},
	);
	const payload = await response.json();
	if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
	return payload as T;
}

export function openRemoteFiles(): AccountFiles {
	const listeners = new Set<() => void>();
	let fingerprint = '';
	const poll = async () => {
		try {
			const files = await call<WireFile[]>('snapshot');
			const next = files
				.map((file) => `${file.path}:${file.revision}`)
				.join('\0');
			if (fingerprint && next !== fingerprint)
				for (const listener of listeners) listener();
			fingerprint = next;
		} catch {
			/* UI requests report errors directly. */
		}
	};
	setInterval(poll, 1000);
	return {
		async list() {
			return call<string[]>('list');
		},
		async read(path) {
			const file = await call<WireFile | null>(
				`read?path=${encodeURIComponent(path)}`,
			);
			return file ? decode(file) : undefined;
		},
		async snapshot() {
			return (await call<WireFile[]>('snapshot')).map(decode);
		},
		async create(path, bytes) {
			return decode(
				await call<WireFile>('create', { path, bytes: encode(bytes) }),
			);
		},
		async replace(source, bytes) {
			return decode(
				await call<WireFile>('replace', {
					path: source.path,
					revision: source.revision,
					bytes: encode(bytes),
				}),
			);
		},
		async publishRow(rowPath, row, attachment) {
			await call('publish-row', {
				rowPath,
				row: encode(row),
				attachment: attachment && {
					path: attachment.path,
					bytes: encode(attachment.bytes),
				},
			});
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

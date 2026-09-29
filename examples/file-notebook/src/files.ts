export type FileSnapshot = {
	path: string;
	bytes: Uint8Array;
	revision: string;
};

export type AccountFiles = {
	list(): Promise<string[]>;
	read(path: string): Promise<FileSnapshot | undefined>;
	snapshot(): Promise<FileSnapshot[]>;
	create(path: string, bytes: Uint8Array): Promise<FileSnapshot>;
	replace(source: FileSnapshot, bytes: Uint8Array): Promise<FileSnapshot>;
	publishRow(
		rowPath: string,
		row: Uint8Array,
		attachment?: { path: string; bytes: Uint8Array },
	): Promise<void>;
	subscribe(listener: () => void): () => void;
};

export function checkedPath(path: string): string {
	if (
		!path ||
		path.startsWith('/') ||
		path.includes('\\') ||
		path.includes('\0') ||
		path.split('/').some((part) => part === '' || part === '.' || part === '..')
	) {
		throw new Error(`Invalid account file path: ${path}`);
	}
	return path;
}

export function sameRowId(path: string): string | undefined {
	const match =
		/^(.+)\/([a-z0-9][a-z0-9_-]*)(?:~[a-z0-9]+(?:-[a-z0-9]+)*)?\.md$/.exec(
			path,
		);
	return match ? `${match[1]}/${match[2]}` : undefined;
}

export function rowStem(path: string): string {
	if (!path.endsWith('.md')) throw new Error('A row needs a .md path');
	return path.slice(0, -3);
}

export function attachmentFor(rowPath: string, extension: string): string {
	if (!/^[a-z0-9]+$/i.test(extension) || extension.toLowerCase() === 'md') {
		throw new Error('Invalid attachment extension');
	}
	return `${rowStem(rowPath)}.${extension.toLowerCase()}`;
}

export function isLfsPointer(bytes: Uint8Array): boolean {
	const prefix = new TextEncoder().encode(
		'version https://git-lfs.github.com/spec/v1\n',
	);
	return prefix.every((byte, index) => bytes[index] === byte);
}

export function publicationConflict(
	existing: string[],
	proposed: string[],
	rowPath?: string,
): string | undefined {
	for (const path of proposed) checkedPath(path);
	for (const [index, path] of proposed.entries()) {
		for (const other of [...existing, ...proposed.slice(index + 1)]) {
			const first = path.toLowerCase();
			const second = other.toLowerCase();
			if (
				first === second ||
				first.startsWith(`${second}/`) ||
				second.startsWith(`${first}/`)
			) {
				return `Paths collide: ${path} and ${other}`;
			}
		}
	}
	if (!rowPath) return undefined;
	const identity = sameRowId(rowPath);
	if (!identity) return `Invalid row path: ${rowPath}`;
	const stem = rowStem(rowPath).toLowerCase();
	if (
		existing.some(
			(path) =>
				sameRowId(path)?.toLowerCase() === identity.toLowerCase() ||
				path.toLowerCase().startsWith(`${stem}.`),
		)
	) {
		return `Row identity or attachment already exists: ${rowPath}`;
	}
	return undefined;
}

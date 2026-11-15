/** Give writing tests a committed app repository, as a public source copy would be. */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { fixture } from './runner.test-support.js';

export async function writingSource(f: Awaited<ReturnType<typeof fixture>>) {
	const code = join(import.meta.dir, '../../../examples/writing');
	const files: Record<string, string> = {};
	for (const entry of await readdir(code, {
		recursive: true,
		withFileTypes: true,
	})) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name).slice(code.length + 1);
		if (path.split('/').includes('node_modules') || path.startsWith('ui/dist/'))
			continue;
		files[`writing/${path}`] = await readFile(join(code, path), 'utf8');
	}
	return f.folder(join(f.root, 'source'), files, { git: true });
}

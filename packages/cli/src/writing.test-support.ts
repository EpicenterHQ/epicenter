/** Give writing tests the Writing example's code, as a copy of its folder would be. */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { fixture } from './runner.test-support.ts';

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
	return f.folder(join(f.root, 'source'), files);
}

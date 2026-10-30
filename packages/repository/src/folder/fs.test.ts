/**
 * Folder Port Tests
 *
 * The folder port's conformance checks (`fs.checks.ts`) against the memory
 * adapter and the Bun one, and what only the memory adapter can show
 * deterministically: an editor's file created between the capture and the
 * link stays, and dropping a captured file unread is caught.
 *
 * Key behaviors:
 * - Every check in `FOLDER_FS_CHECKS` holds for both adapters
 * - A file created between `replace`'s capture and its link stays, and the write reports it did not happen
 * - Dropping a captured file the engine never read is a violation
 */
import { expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createBunFolderFs } from '../bun/folder-fs.js';
import { FOLDER_FS_CHECKS } from './fs.checks.js';
import { createMemoryFolderFs } from './fs.js';

const encoder = new TextEncoder();
const realTime = {
	after: (ms: number, run: () => void) => void setTimeout(run, ms),
	now: () => Date.now(),
};

for (const [name, run] of Object.entries(FOLDER_FS_CHECKS)) {
	test(`memory: ${name}`, async () => {
		const memory = createMemoryFolderFs(realTime);
		await run(memory.port, {
			write: async (path, text) =>
				void memory.write(path, encoder.encode(text)),
			symlink: async (path, target) => void memory.symlink(path, target),
			text: async (path) => memory.text(path),
		});
		expect(memory.violations.filter((v) => !v.includes('unread'))).toEqual([]);
	});
	test(`bun: ${name}`, async () => {
		const root = await mkdtemp(join(tmpdir(), 'folder-fs-'));
		try {
			await run(createBunFolderFs(root), {
				async write(path, text) {
					await mkdir(dirname(join(root, path)), { recursive: true });
					await writeFile(join(root, path), text);
				},
				symlink: (path, target) => symlink(target, join(root, path)),
				text: (path) => readFile(join(root, path), 'utf8').catch(() => null),
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("memory: an editor's file created between the capture and the link stays, and the write says it did not happen", async () => {
	const steps: (() => void)[] = [];
	const memory = createMemoryFolderFs({
		after: (_ms, run) => void steps.push(run),
		now: () => 0,
	});
	memory.write('a.md', encoder.encode('engine'));
	const replacing = memory.port.replace('a.md', new Blob(['next']), {
		scratch: 'd-1',
	});
	// Run the capture, then let an editor save before the link.
	const step = async () => {
		await Promise.resolve();
		await Promise.resolve();
		steps.shift()?.();
		await Promise.resolve();
	};
	await step();
	await step();
	memory.write('a.md', encoder.encode('theirs'));
	while (steps.length > 0) await step();
	const done = await replacing;
	expect(done.data).toEqual({ written: false, entry: null, displaced: 'd-1' });
	expect(memory.text('a.md')).toBe('theirs');
});

test('memory: dropping a captured file unread is caught', async () => {
	const memory = createMemoryFolderFs(realTime);
	memory.write('a.md', encoder.encode('theirs'));
	await memory.port.remove('a.md', { scratch: 'd-1' });
	await memory.port.drop('d-1');
	expect(memory.violations).toEqual([
		'the engine dropped d-1 unread: "theirs"',
	]);
});

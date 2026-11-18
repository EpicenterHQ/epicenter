/**
 * The folder as one zip file (`export.ts`), as a browser's Export gives it.
 *
 * Key behaviors:
 * - Export holds `settings.md` and the five directories' files, at their
 *   paths under one root, and nothing else
 * - The zip reads back whole in another program (`unzip`), checksums
 *   included
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { folderFiles, zipOf } from './export.js';
import { encode } from './files/files.js';
import { memoryFiles } from './files/memory.js';

const audio = new Uint8Array(70_000).map((_, index) => (index * 31) % 256);

const files = memoryFiles({
	'settings.md': encode('---\nshortcut: Alt+R\n---\n'),
	'recordings/a.md': encode('---\ntitle: "A"\n---\nnotes\n'),
	'recordings/a.webm': audio,
	'recordings/.ep-x-b.recording': encode('a take in progress'),
	'transcriptions/t.md': encode('---\nrecordingId: a\n---\nhello\n'),
	'elsewhere/kept.md': encode('not Whispering’s'),
});

test('export holds settings.md and the five directories, and nothing else', async () => {
	const entries = expectOk(await folderFiles(files));
	expect(entries.map(({ path }) => path).sort()).toEqual([
		'recordings/a.md',
		'recordings/a.webm',
		'settings.md',
		'transcriptions/t.md',
	]);
});

test('the zip reads back whole in another program', async () => {
	const blob = expectOk(
		zipOf('whispering', expectOk(await folderFiles(files))),
	);
	const dir = mkdtempSync(join(tmpdir(), 'whispering-export-'));
	try {
		const zip = join(dir, 'export.zip');
		writeFileSync(zip, new Uint8Array(await blob.arrayBuffer()));
		const checked = Bun.spawnSync(['unzip', '-t', zip]);
		expect(checked.stdout.toString()).toContain('No errors detected');
		expect(Bun.spawnSync(['unzip', '-q', zip, '-d', dir]).exitCode).toBe(0);
		expect(
			new Uint8Array(readFileSync(join(dir, 'whispering/recordings/a.webm'))),
		).toEqual(audio);
		expect(readFileSync(join(dir, 'whispering/settings.md'), 'utf8')).toContain(
			'shortcut: Alt+R',
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

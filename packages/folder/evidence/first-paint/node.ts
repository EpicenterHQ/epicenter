/**
 * First paint over a directory, as the desktop's data folder holds it
 * (ADR-0778): the time from the page starting to the folder's snapshot
 * landing and the recordings collection's first read (the parse a page's
 * first render makes), with about 5,000 recording notes, and again with an
 * audio file beside each. Run with Bun:
 *
 *   bun packages/folder/evidence/first-paint/node.ts [notes]
 *
 * The desktop reads the same files through the shell's commands, one IPC
 * call per note, so its time adds that crossing; Bun's `node:fs` does not.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineContract } from '@epicenter/definition/contract';
import { openFolder } from '../../src/home.js';
import { directory } from '../../src/node.js';

const NOTES = Number(Bun.argv[2] ?? 5000);

const contract = defineContract({
	collections: {
		recordings: {
			path: 'recordings/{id}.md',
			fields: {
				title: { type: 'string' },
				recordedAt: { type: 'string' },
				durationMs: { type: 'number' },
			},
			required: ['title', 'recordedAt'],
		},
		audio: { path: 'recordings/{id}.{ext}' },
	},
});

/** A recording note about as long as Whispering's: its fields and a short transcript. */
const note = (index: number) =>
	`---\ntitle: Recording ${index}\nrecordedAt: "2026-10-${String((index % 28) + 1).padStart(2, '0')}T09:30:00.000Z"\ndurationMs: ${1000 + index}\n---\n${'A sentence of what was said, as a transcript keeps it. '.repeat(4)}\n`;

async function seed(root: string, audio: boolean) {
	await mkdir(join(root, 'recordings'), { recursive: true });
	const bytes = new Uint8Array(32 * 1024);
	for (let start = 0; start < NOTES; start += 500)
		await Promise.all(
			Array.from({ length: Math.min(500, NOTES - start) }, async (_, offset) => {
				const index = start + offset;
				const id = `2026-10-31T09-30-00-${String(index).padStart(6, '0')}`;
				await writeFile(join(root, `recordings/${id}.md`), note(index));
				if (audio) await writeFile(join(root, `recordings/${id}.webm`), bytes);
			}),
		);
}

/** Open the folder at `root` and read the recordings once: the first paint's work. */
async function firstPaint(root: string) {
	const started = performance.now();
	const folder = openFolder(contract, directory(root));
	await new Promise<void>((resolve) => {
		const stop = folder.subscribe(() => {
			if (folder.state().status !== 'open') return;
			stop();
			resolve();
		});
	});
	const connected = performance.now();
	const shown = folder.recordings.items().length;
	const painted = performance.now();
	folder[Symbol.dispose]();
	return {
		connectMs: Math.round(connected - started),
		parseMs: Math.round(painted - connected),
		firstPaintMs: Math.round(painted - started),
		shown,
	};
}

for (const audio of [false, true]) {
	const root = await mkdtemp(join(tmpdir(), 'first-paint-'));
	try {
		await seed(root, audio);
		// The first run warms the disk cache, as a second launch would.
		const cold = await firstPaint(root);
		const warm = await firstPaint(root);
		console.log(
			JSON.stringify({
				store: 'directory',
				notes: NOTES,
				audioFiles: audio ? NOTES : 0,
				cold,
				warm,
			}),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

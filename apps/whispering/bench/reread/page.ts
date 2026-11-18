/**
 * The page's half of one folder re-read, timed over a folder `fixture.ts`
 * wrote (`bench/reread/README.md`). The shell is a stand-in `invoke` that
 * answers what Whispering's `files_list` and `files_read_many` answer, built
 * from the folder before the clock starts, so only the page's work is timed:
 *
 * - `json`: parsing the listings' JSON, as `invoke` does with a JSON answer;
 * - `unpack`: `readManyAnswer`, the one buffer cut into each note's bytes;
 * - `parse` and `check`: each note decoded, read in the Markdown grammar,
 *   and its fields checked with TypeBox (`notes.ts`'s `readNote`);
 * - `folder.read`: all of it through the app's own `openFolder(tauriFiles)`;
 * - `share`: TanStack Query's structural sharing of the new snapshot with
 *   the one before, when nothing changed and when one note did;
 * - `library` and `table`: what `library.svelte.ts` derives from a changed
 *   snapshot and `shownRows` (`recordings-table.ts`) over it, with no
 *   search and with one; `audioOf` is the table's per-row audio lookup.
 *
 * Usage: `bun bench/reread/page.ts <folder> [runs]`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { replaceEqualDeep } from '@tanstack/query-core';
import type { Entry } from '../../src/lib/files/files.js';
import { readManyAnswer, tauriFiles } from '../../src/lib/files/tauri.js';
import {
	audioOf,
	type FolderSnapshot,
	newest,
	openFolder,
	type TranscriptionNote,
	unnotedOf,
} from '../../src/lib/folder.js';
import { checkNote, NOTES } from '../../src/lib/format/layout.js';
import { parseNote } from '../../src/lib/format/note.js';
import { DEFAULT_SORT, shownRows } from '../../src/lib/recordings-table.js';

const [dir, runsText = '8'] = process.argv.slice(2);
if (dir === undefined) {
	console.error('Usage: bun bench/reread/page.ts <folder> [runs]');
	process.exit(1);
}
const runs = Number(runsText);

// --- the shell's answers, built before timing -------------------------------

/** `files_list`'s answer as JSON, as `whispering_files::list` makes it. */
function listJson(sub: string) {
	const entries: Entry[] = readdirSync(join(dir as string, sub))
		.sort()
		.map((name) => {
			const stat = statSync(join(dir as string, sub, name));
			return { name, size: stat.size, modifiedMs: Math.floor(stat.mtimeMs) };
		});
	return JSON.stringify(entries);
}
const listed: Record<string, string> = {
	recordings: listJson('recordings'),
	transcriptions: listJson('transcriptions'),
};

/** `files_read_many`'s one buffer for `paths`: count, lengths, then bytes. */
function readManyBuffer(paths: readonly string[]) {
	const bodies = paths.map((path) => readFileSync(join(dir as string, path)));
	const size = bodies.reduce((total, body) => total + body.length, 0);
	const buffer = new Uint8Array(4 + 4 * paths.length + size);
	const view = new DataView(buffer.buffer);
	view.setUint32(0, paths.length, true);
	let at = 4 + 4 * paths.length;
	for (const [index, body] of bodies.entries()) {
		view.setUint32(4 + 4 * index, body.length, true);
		buffer.set(body, at);
		at += body.length;
	}
	return buffer;
}
const answers = new Map<string, Uint8Array>();
for (const sub of ['recordings', 'transcriptions']) {
	const paths = (JSON.parse(listed[sub] as string) as Entry[])
		.filter(({ name }) => name.endsWith('.md'))
		.map(({ name }) => `${sub}/${name}`);
	answers.set(sub, readManyBuffer(paths));
}

let sentBytes = 0;
const files = tauriFiles('/fixture', async (command, args) => {
	const { dir: sub, paths } = args as { dir?: string; paths?: string[] };
	if (command === 'files_list') return JSON.parse(listed[sub ?? ''] as string);
	if (command === 'files_read_many') {
		// The page sends `{ folder, paths }` as JSON.
		sentBytes += JSON.stringify(args).length;
		const kind = (paths?.[0] ?? '').split('/')[0] as string;
		return answers.get(kind);
	}
	throw new Error(`The stand-in shell has no ${command}`);
});
const folder = openFolder(files);

// --- timing -----------------------------------------------------------------

/** Each part's time in each run; a part timed twice in a run (once per kind) adds up. */
const results = new Map<string, number[]>();
let run = 0;
function record(name: string, took: number) {
	const times = results.get(name) ?? [];
	times[run] = (times[run] ?? 0) + took;
	results.set(name, times);
}
function time<T>(name: string, work: () => T): T {
	const at = performance.now();
	const out = work();
	record(name, performance.now() - at);
	return out;
}
async function timeAsync<T>(name: string, work: () => Promise<T>): Promise<T> {
	const at = performance.now();
	const out = await work();
	record(name, performance.now() - at);
	return out;
}
const median = (values: number[]) => {
	const sorted = values
		.filter((value) => value !== undefined)
		.sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] as number;
};

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The library's derivations (`library.svelte.ts`) over `snapshot`, and its table's `Source`. */
function libraryOf(snapshot: FolderSnapshot) {
	const entries = [
		...snapshot.recordings.items,
		...unnotedOf(snapshot),
	].toSorted(newest((note) => note.recordedAt));
	const transcriptions = snapshot.transcriptions.items.toSorted(
		newest((note) => note.createdAt),
	);
	const byRecording = new Map<string, TranscriptionNote[]>();
	for (const note of transcriptions)
		byRecording.set(note.recordingId, [
			...(byRecording.get(note.recordingId) ?? []),
			note,
		]);
	return {
		entries,
		transcriptsFor: (id: string) => byRecording.get(id) ?? [],
		transcribing: (_id: string) => false,
		audioOf: (id: string) => audioOf(snapshot, id),
	};
}

let previous: FolderSnapshot | undefined;
for (run = 0; run < runs; run++) {
	sentBytes = 0;
	// The parts, one at a time.
	const [recordings, transcriptions] = time('json', () => [
		JSON.parse(listed.recordings as string) as Entry[],
		JSON.parse(listed.transcriptions as string) as Entry[],
	]);
	for (const [kind, entries] of [
		['recordings', recordings],
		['transcriptions', transcriptions],
	] as const) {
		const paths = entries
			.filter(({ name }) => name.endsWith('.md'))
			.map(({ name }) => `${kind}/${name}`);
		const notes = time('unpack', () =>
			readManyAnswer(paths, answers.get(kind) as Uint8Array),
		);
		const texts = time('decode', () =>
			[...notes.values()].map((bytes) => strict.decode(bytes)),
		);
		time('parse', () => texts.map((text) => parseNote(text)));
		time('parse+check', () =>
			texts.map((text) => checkNote(NOTES[kind].fields, text)),
		);
	}

	// All of it, as the query runs it.
	const read = await timeAsync('folder.read', () => folder.read());
	if (read.error !== null) throw new Error(read.error.message);
	const snapshot = read.data;

	if (previous !== undefined) {
		time('share (unchanged)', () => replaceEqualDeep(previous, snapshot));
		const items = [...snapshot.transcriptions.items];
		items[0] = { ...(items[0] as TranscriptionNote), body: 'changed' };
		const changed = {
			...snapshot,
			transcriptions: { ...snapshot.transcriptions, items },
		};
		time('share (one changed)', () => replaceEqualDeep(previous, changed));
	}
	previous = snapshot;

	const library = time('library', () => libraryOf(snapshot));
	time('audioOf x rows', () => {
		for (const note of library.entries) library.audioOf(note.id);
	});
	time('table', () => shownRows(library, '', DEFAULT_SORT));
	time('table (search "deadline")', () =>
		shownRows(library, 'deadline', DEFAULT_SORT),
	);
}

const snapshot = previous as FolderSnapshot;
console.log(
	`${dir}: ${snapshot.recordings.items.length} recordings, ${snapshot.transcriptions.items.length} transcripts, ${snapshot.audio.length} audio, ${snapshot.recordings.invalid.length + snapshot.transcriptions.invalid.length} invalid`,
);
console.log(
	`bytes in: lists ${(listed.recordings as string).length + (listed.transcriptions as string).length}, notes ${[...answers.values()].reduce((total, buffer) => total + buffer.length, 0)}; bytes out: ${sentBytes}`,
);
console.log(
	`part,median_ms,min_ms (${runs} runs; the first is the JIT's warmup)`,
);
for (const [name, values] of results)
	console.log(
		`${name},${median(values).toFixed(1)},${Math.min(...values.filter((value) => value !== undefined)).toFixed(1)}`,
	);

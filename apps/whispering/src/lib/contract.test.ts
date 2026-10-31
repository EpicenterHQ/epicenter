/**
 * Whispering's contract against what Whispering writes. A folder the table
 * API wrote, desktop or browser, fits it with no issues; and its fields are
 * the tables' own schemas, so the two cannot drift apart unnoticed.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstantString } from '@epicenter/definition';
import { checkContract, compileContract } from '@epicenter/definition/contract';
import { expectOk } from 'wellcrafted/testing';
import { whispering } from './contract.js';
import { recordingAudioStem, whisperingTables } from './definition.js';
import { maintainExclusions } from './exclusions.js';
import { openTestFolder } from './services.test-support.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A table's schema as the contract states it: without the table API's `x-field` annotations. */
function withoutAnnotations(schema: object): unknown {
	return JSON.parse(
		JSON.stringify(schema, (key, value) =>
			key === 'x-field' ? undefined : value,
		),
	);
}

/** Every file under `root`, as `checkContract` takes them: notes with their text. */
async function filesUnder(root: string) {
	const paths = await readdir(root, { recursive: true, withFileTypes: true });
	return Promise.all(
		paths
			.filter((entry) => entry.isFile())
			.map(async (entry) => {
				const path = join(entry.parentPath, entry.name)
					.slice(root.length + 1)
					.replaceAll('\\', '/');
				return path.endsWith('.md')
					? { path, text: await readFile(join(root, path), 'utf8') }
					: { path };
			}),
	);
}

test('the contract compiles', () => {
	expect(compileContract(whispering).error).toBeNull();
});

test('the published contract is the one in code (run `bun run contract` when it is not)', async () => {
	const published = await Bun.file(
		new URL('../../static/contract.json', import.meta.url),
	).json();
	expect(published).toEqual(whispering);
});

test("each table is a note collection at `<table>/{id}.md` whose fields are the table's schema", () => {
	const { audio, ...notes } = whispering.collections;
	expect(audio).toEqual({ path: 'recordings/{id}.{ext}' });
	expect(Object.keys(notes).sort()).toEqual(
		Object.keys(whisperingTables).sort(),
	);
	for (const [table, schema] of Object.entries(whisperingTables)) {
		const collection = notes[table as keyof typeof notes];
		expect<string>(collection.path).toBe(`${table}/{id}.md`);
		expect<unknown>(collection.fields).toEqual(
			withoutAnnotations(schema.properties),
		);
		expect<string[]>([...collection.required].sort()).toEqual(
			[...schema.required].sort(),
		);
	}
});

test('a folder written through the table API fits the contract with no issues', async () => {
	const root = await mkdtemp(join(tmpdir(), 'whispering-contract-'));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const { folder } = await openTestFolder(root);
	const now = InstantString.fromDate(new Date('2026-01-02T03:04:05.000Z'));
	const tables = folder.tables;
	const standup = '20260102-030405-k3f9';
	const cutOff = '20260102-030406-a1b2';

	expectOk(await maintainExclusions(folder));
	expectOk(
		await tables.recordings.create(standup, {
			fields: { title: 'Standup', recordedAt: now, capture: 'microphone' },
			body: 'Notes on the standup.',
		}),
	);
	expectOk(
		await tables.recordings.update(standup, {
			fields: { durationMs: 1234 },
		}),
	);
	// Cut off before it stopped: no length.
	expectOk(
		await tables.recordings.create(cutOff, {
			fields: { title: 'Fixture', recordedAt: now, capture: 'fixture' },
			body: '',
		}),
	);
	for (const [id, ext] of [
		[standup, 'webm'],
		[cutOff, 'wav'],
	] as const)
		expectOk(
			await folder.write(
				`${recordingAudioStem(id)}.${ext}`,
				new Uint8Array([1, 2, 3]),
			),
		);
	expectOk(
		await tables.transcriptions.create('t1', {
			fields: {
				recordingId: standup,
				createdAt: now,
				model: 'whisper-1',
				endpoint: 'https://api.openai.com/v1',
			},
			body: 'Hello.',
		}),
	);
	expectOk(
		await tables.transformations.create('tidy', {
			fields: { title: 'Tidy', model: null },
			body: 'Tidy the transcript.',
		}),
	);
	expectOk(
		await tables.transformations.create('summary', {
			fields: { title: 'Summary', model: 'gpt-4o-mini' },
			body: 'Summarize it.',
		}),
	);
	const run = {
		transformationId: 'tidy',
		transformationTitle: 'Tidy',
		createdAt: now,
		model: 'gpt-4o-mini',
		endpoint: 'https://api.openai.com/v1',
		prompt: 'Tidy the transcript.',
		input: 'Hello.',
	};
	expectOk(
		await tables.transformation_runs.create('r1', {
			fields: { ...run, recordingId: standup, transcriptionId: 't1' },
			body: 'Hello!',
		}),
	);
	expectOk(
		await tables.text_runs.create('p1', { fields: run, body: 'Hello!' }),
	);

	const files = await filesUnder(root);
	expect(files.map(({ path }) => path).sort()).toEqual([
		'.gitignore',
		'recordings/20260102-030405-k3f9.md',
		'recordings/20260102-030405-k3f9.webm',
		'recordings/20260102-030406-a1b2.md',
		'recordings/20260102-030406-a1b2.wav',
		'text_runs/p1.md',
		'transcriptions/t1.md',
		'transformation_runs/r1.md',
		'transformations/summary.md',
		'transformations/tidy.md',
	]);
	expect(expectOk(checkContract(whispering, files))).toEqual([]);
});

test('a note the contract does not describe is an issue, as is a field that does not fit', () => {
	const issues = expectOk(
		checkContract(whispering, [
			// Files can make a note anywhere in a folder; the contract names five directories.
			{ path: 'ideas/later.md', text: '---\ntitle: Later\n---\n' },
			{
				path: 'recordings/20260102-030405-k3f9.md',
				text: '---\ntitle: Standup\nrecordedAt: yesterday\ncapture: microphone\n---\n',
			},
		]),
	);
	// One issue per keyword a value fails (here `format` and `pattern`).
	expect(new Set(issues.map(({ path, field }) => `${path} ${field}`))).toEqual(
		new Set([
			'ideas/later.md undefined',
			'recordings/20260102-030405-k3f9.md recordedAt',
		]),
	);
});

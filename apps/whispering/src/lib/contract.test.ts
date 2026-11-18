/**
 * Whispering's contract: the published copy is the one in code, it
 * compiles, and the files the app writes fit it with no issues (what
 * `epicenter check` reports for a clone).
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { whispering } from './contract.js';
import { checkContract, compileContract } from './format/contract/index.js';
import { timeId } from './format/ids.js';
import { testFiles } from './services.test-support.js';

test('the published contract is the one in code (run `bun run contract` when it is not)', async () => {
	const published = await Bun.file(
		new URL('../../static/contract.json', import.meta.url),
	).json();
	expect(published).toEqual(whispering);
});

test('the contract compiles', () => {
	expect(compileContract(whispering).error).toBeNull();
});

test('the files Whispering writes fit its contract with no issues', async () => {
	const { files, outside } = testFiles();
	const { openFolder } = await import('./folder.svelte.js');
	const folder = openFolder(files);
	const at = new Date('2026-10-31T09:30:00.000Z');
	const id = timeId(at);
	// A recording, as Stop keeps it: its audio, then its note.
	await outside.write(`recordings/${id}.m4a`, new Uint8Array([1, 2, 3]));
	expectOk(
		await folder.recordings.set(
			{ id },
			{ title: 'Standup', recordedAt: at.toISOString(), durationMs: 1500 },
		),
	);
	const transcription = timeId();
	expectOk(
		await folder.transcriptions.set(
			{ id: transcription },
			{
				recordingId: id,
				createdAt: new Date().toISOString(),
				model: 'whisper-1',
				endpoint: 'https://api.openai.com/v1',
				body: 'um so a steady tone\n',
			},
		),
	);
	const recipe = timeId();
	expectOk(
		await folder.transformations.set(
			{ id: recipe },
			{ title: 'Clean up', model: null, body: 'Fix punctuation.\n' },
		),
	);
	const run = {
		transformationId: recipe,
		transformationTitle: 'Clean up',
		createdAt: new Date().toISOString(),
		model: 'gpt-4o-mini',
		endpoint: 'https://api.openai.com/v1',
		prompt: 'Fix punctuation.\n',
		input: 'um so a steady tone\n',
		body: 'A steady tone.\n',
	};
	expectOk(
		await folder.transformation_runs.set(
			{ id: timeId() },
			{ recordingId: id, transcriptionId: transcription, ...run },
		),
	);
	expectOk(await folder.text_runs.set({ id: timeId() }, run));
	// The settings: a connection without its key, a model for each job, the shortcut.
	await folder.settings.connections.save([
		{
			id: 'openai',
			name: 'OpenAI',
			baseUrl: 'https://api.openai.com/v1',
			models: ['whisper-1'],
			key: 'https://api.openai.com/v1',
		},
	]);
	expectOk(
		await folder.settings.choices.set('transcribe', {
			endpoint: 'openai',
			model: 'whisper-1',
		}),
	);
	expectOk(await folder.settings.setShortcut('CommandOrControl+Shift+K'));

	const paths = outside.paths();
	const read = await Promise.all(
		paths.map(async (path) => ({
			path,
			text: path.endsWith('.md')
				? ((await outside.read(path)) ?? undefined)
				: undefined,
		})),
	);
	expect(expectOk(checkContract(whispering, read))).toEqual([]);
	expect(paths).toHaveLength(7);
	expect(paths).toContain('settings.md');
});

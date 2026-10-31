/**
 * Whispering's contract: the published copy is the one in code, it
 * compiles, and the files the app writes fit it with no issues (what
 * `epicenter check` reports for a clone).
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileContract } from '@epicenter/definition/contract';
import { timeId } from '@epicenter/definition/ids';
import { checkFiles, openDevice } from '@epicenter/folder/node';
import { unwrap } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { whispering } from './contract.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

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
	const root = await mkdtemp(join(tmpdir(), 'whispering-contract-'));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const device = unwrap(await openDevice(whispering, { path: root }));
	const at = new Date('2026-10-31T09:30:00.000Z');
	const id = timeId(at);
	// A recording, as Stop keeps it: its audio, then its note.
	expectOk(
		await device.audio.create({
			id,
			ext: 'm4a',
			bytes: new Uint8Array([1, 2, 3]),
		}),
	);
	expectOk(
		await device.recordings.create({
			id,
			title: 'Standup',
			recordedAt: at.toISOString(),
			durationMs: 1500,
			capture: 'microphone',
		}),
	);
	const transcription = timeId();
	expectOk(
		await device.transcriptions.create({
			id: transcription,
			recordingId: id,
			createdAt: new Date().toISOString(),
			model: 'whisper-1',
			endpoint: 'https://api.openai.com/v1',
			body: 'um so a steady tone\n',
		}),
	);
	const recipe = timeId();
	expectOk(
		await device.transformations.create({
			id: recipe,
			title: 'Clean up',
			model: null,
			body: 'Fix punctuation.\n',
		}),
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
		await device.transformation_runs.create({
			id: timeId(),
			recordingId: id,
			transcriptionId: transcription,
			...run,
		}),
	);
	expectOk(await device.text_runs.create({ id: timeId(), ...run }));

	const checked = expectOk(await checkFiles(whispering, { path: root }));
	expect(checked.issues).toEqual([]);
	expect(checked.files).toBe(6);
});

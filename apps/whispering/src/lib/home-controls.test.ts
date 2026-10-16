/**
 * Home controls tests: post-processing choice and connection choices
 *
 * Drives a real session over a real directory with stubbed endpoints that
 * count every request. No component is mounted, so these establish what the
 * controls' state does and what reaches the folder and the endpoints, not how
 * the controls look.
 *
 * Key behaviors:
 * - A session starts with post-processing set to None and no transformation
 *   in the folder
 * - Choosing a transformation, recording, stopping, and transcribing send no
 *   transformation request; only an explicit run does, once
 * - A run saves a separate result file and leaves the transcript's file as
 *   it was
 * - The choice is read against the folder and the text connection by the
 *   library's one resolver: a deleted transformation is missing, one with no
 *   text connection to run over cannot run, and neither runs
 * - Choosing a connection writes only the choice to `kv.json`, never a key,
 *   and asks no endpoint anything
 * - A local connection is never the text connection
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { folderOptions } from '@epicenter/folder/query';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { STARTER_TRANSFORMATIONS } from './definition.js';
import { settle, transformationEditor } from './edits.test-support.js';
import { createQueryClient } from './query.test-support.js';
import type { Session } from './session.svelte.js';
import type { Workspace } from './workspace/types.js';
import {
	openTestWorkspace,
	type TestWorkspaceOptions,
} from './workspace.test-support.js';

const { openSession } = await import('./session.svelte.ts');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(
	change: (workspace: Workspace) => Workspace = (workspace) => workspace,
	options: TestWorkspaceOptions = {},
) {
	const test = await openTestWorkspace(options);
	const workspace = change(test.workspace);
	const session: Session = expectOk(
		await openSession(createQueryClient(), async () => Ok(workspace)),
	);
	cleanups.push(async () => {
		await session.close();
		await test.remove();
	});
	return {
		session,
		library: session.library,
		view: session.view,
		...test,
	};
}

const names = (root: string, directory: string) =>
	readdir(join(root, directory)).catch(() => [] as string[]);

/** Create the cleanup starter, optionally with the model a run needs. */
async function cleanup(session: Session, model?: string) {
	const { library } = session;
	expect(
		await library.createTransformation(STARTER_TRANSFORMATIONS[0]!),
	).toBeUndefined();
	const draft = transformationEditor(library);
	if (model !== undefined) {
		draft.edit((row) => {
			row.fields.model = model;
		});
		await settle(library);
	}
	return library.transformations[0]!;
}

test('a session starts with post-processing set to None and seeds no transformation', async () => {
	const { session, library, view, root, transformed } = await open();

	expect(view.postProcessing).toBeUndefined();
	expect(session.postProcessing).toEqual({ kind: 'none' });
	expect(library.transformations).toEqual([]);
	expect(await names(root, 'transformations')).toEqual([]);
	expect(transformed).toEqual([]);
});

test('choosing, recording, stopping, and transcribing send nothing to the transformation; an explicit run sends it once', async () => {
	const { session, library, view, root, transformed, transcribed } =
		await open();
	const profile = await cleanup(session, 'chat-model');

	view.postProcessing = profile.path;
	expect(session.postProcessing.kind).toBe('ready');
	await library.startRecording();
	await library.stopRecording();
	// Nothing is transcribed by recording either.
	expect(transcribed).toEqual([]);
	await library.transcribe(library.entries[0]!);
	await settle(library);

	expect(transformed).toEqual([]);
	expect(await names(root, 'transformation_runs')).toEqual([]);
	// The choice is the session's: a page change builds nothing new, so it is still chosen.
	expect(session.view.postProcessing).toBe(profile.path);

	const transcript = library.resultsFor(library.entries[0]!.stem)[0]!;
	const before = await readFile(join(root, transcript.path));
	expect(
		await library.transform(transcript.path, profile.path),
	).toBeUndefined();

	expect(transformed).toHaveLength(1);
	expect(transformed[0]).toMatchObject({
		model: 'chat-model',
		input: 'um so a steady tone\n',
	});
	expect(await names(root, 'transformation_runs')).toHaveLength(1);
	expect(library.outputsFor(transcript.stem)).toHaveLength(1);
	expect(library.recipeRuns).toEqual([]);
	expect((await readFile(join(root, transcript.path))).equals(before)).toBe(
		true,
	);
});

test('a chosen transformation with no text connection to run over cannot run, and one that was deleted is missing; neither is run', async () => {
	const { session, library, view, root, transformed } = await open(undefined, {
		connections: { text: null },
	});
	const profile = await cleanup(session);
	view.postProcessing = profile.path;

	// A new transformation uses the text connection, and none is chosen.
	expect(session.postProcessing).toMatchObject({
		kind: 'repair',
		reason: 'Choose a text connection in Settings to run this.',
	});
	expect(await library.transform('transcriptions/none.md', profile.path)).toBe(
		'Choose a text connection in Settings to run this.',
	);

	await rm(join(root, profile.path));
	await settle(library);

	expect(session.postProcessing).toEqual({
		kind: 'missing',
		path: profile.path,
	});
	// The choice is shown as it is, not replaced.
	expect(view.postProcessing).toBe(profile.path);
	expect(transformed).toEqual([]);
});

test('the folder being read is reported while it is read, and not after', async () => {
	const { library } = await open();
	expect(library.refreshing).toBe(false);

	// A change the folder reports, as its change channel reports one.
	const reading = library.queryClient.invalidateQueries(
		folderOptions(library.folder).pathFilter(['recordings/elsewhere.md']),
	);
	expect(library.refreshing).toBe(true);
	await reading;

	expect(library.refreshing).toBe(false);
});

test('choosing a connection writes only the choice to kv.json and asks no endpoint anything', async () => {
	const { library, root, transcribed, transformed } = await open(undefined, {
		connections: { transcription: null },
		others: { groq: { title: 'Groq', model: 'whisper-large-v3', key: 'gsk' } },
	});
	expect(library.connections.transcription).toBeUndefined();

	expect(
		await library.chooseConnection('transcription', 'groq'),
	).toBeUndefined();

	expect(library.connections.transcription).toMatchObject({
		connection: 'groq',
		title: 'Groq',
		model: 'whisper-large-v3',
		unusable: undefined,
	});
	const kv = JSON.parse(await readFile(join(root, 'kv.json'), 'utf8'));
	expect(kv).toEqual({
		textConnection: 'test-text',
		transcriptionConnection: 'groq',
	});
	// A key never reaches the folder.
	expect(JSON.stringify(kv)).not.toContain('gsk');
	expect(transcribed).toEqual([]);
	expect(transformed).toEqual([]);
});

test('a local connection can transcribe on the desktop, and is never the text connection', async () => {
	const { library } = await open(undefined, {
		connections: { text: { kind: 'local', title: 'This computer', model: '' } },
	});
	expect(library.connections.text).toMatchObject({
		kind: 'local',
		unusable:
			'This computer runs on this computer’s local transcription model, which only transcribes.',
	});
});

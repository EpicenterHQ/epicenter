/**
 * Home controls tests: post-processing choice and the settings draft
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
 * - The settings form has one draft per connection: it saves the base URL,
 *   model, and key on the device only, keeps the saved key when none is
 *   typed, refuses to keep a key for another endpoint, and asks no endpoint
 *   anything
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { folderOptions } from '@epicenter/folder/query';
import { Err, Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import type { ConnectionChange } from './connections.js';
import { STARTER_TRANSFORMATIONS } from './definition.js';
import { settle, transformationEditor } from './edits.test-support.js';
import { createQueryClient } from './query.test-support.js';
import type { Session } from './session.svelte.js';
import type { Workspace } from './workspace/types.js';
import {
	deferred,
	openTestWorkspace,
	TEST_BASE_URL,
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

/** The names in a table's directory beside its `.epicenter.json` schema. */
const names = (root: string, directory: string) =>
	readdir(join(root, directory)).then(
		(found) => found.filter((name) => name !== '.epicenter.json'),
		() => [] as string[],
	);

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
		connections: {},
	});
	const profile = await cleanup(session);
	view.postProcessing = profile.path;

	// A new transformation uses the text connection, and none is set up.
	expect(session.postProcessing).toMatchObject({
		kind: 'repair',
		reason: 'Set up the text connection in Settings to run this.',
	});
	expect(await library.transform('transcriptions/none.md', profile.path)).toBe(
		'Set up the text connection in Settings to run this.',
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

test('the settings draft saves a connection on the device only, keeps the saved key when none is typed, and asks no endpoint anything', async () => {
	const { session, library, root, transcribed, transformed, device } =
		await open(undefined, { connections: {} });
	const draft = session.settings.transcription;
	// Not set up: the form starts from the defaults, and nothing is saved.
	expect(draft.saved).toBeUndefined();
	expect(draft.baseUrl).toBe('https://api.openai.com/v1');
	expect(draft.model).toBe('whisper-1');

	draft.baseUrl = 'http://127.0.0.1:9000/v1/';
	draft.model = ' local-whisper ';
	draft.key = 'typed-key';
	expect(await draft.save()).toBeUndefined();

	expect(device.stored.transcription).toEqual({
		baseUrl: 'http://127.0.0.1:9000/v1',
		model: 'local-whisper',
		apiKey: 'typed-key',
	});
	expect(library.connections?.transcription).toMatchObject({
		baseUrl: 'http://127.0.0.1:9000/v1',
		keyPresent: true,
	});
	// The draft follows what was saved, and the key is never read back.
	expect(draft.model).toBe('local-whisper');
	expect(draft.key).toBe('');
	expect(draft.keyAction).toBe('keep');

	draft.model = 'larger-whisper';
	expect(await draft.save()).toBeUndefined();
	expect(device.stored.transcription?.apiKey).toBe('typed-key');

	// Nothing reached the folder, beyond the .gitignore lines opening it
	// writes, or an endpoint.
	expect((await readdir(root)).filter((name) => name !== '.git')).toEqual([
		'.gitignore',
	]);
	expect(transcribed).toEqual([]);
	expect(transformed).toEqual([]);
});

test('a changed endpoint cannot keep the saved key: the draft says why and the device refuses it', async () => {
	const { session, device } = await open(undefined, {
		connections: {
			text: { baseUrl: TEST_BASE_URL, model: 'chat-model', apiKey: 'text-key' },
		},
	});
	const draft = session.settings.text;
	expect(draft.keyAction).toBe('keep');

	// Same origin, another path: another endpoint.
	draft.baseUrl = 'http://127.0.0.1:18080/other/v1';
	expect(draft.problem).toContain('saved key is not sent there');
	expect(await draft.save()).toMatchObject({
		description: expect.stringContaining('saved key is not sent there'),
	});
	expect(device.stored.text).toEqual({
		baseUrl: TEST_BASE_URL,
		model: 'chat-model',
		apiKey: 'text-key',
	});

	// Removing the key, or replacing it, is an explicit choice for the new endpoint.
	draft.keyAction = 'remove';
	expect(draft.problem).toBeUndefined();
	expect(await draft.save()).toBeUndefined();
	expect(device.stored.text).toEqual({
		baseUrl: 'http://127.0.0.1:18080/other/v1',
		model: 'chat-model',
	});
});

test('a connection the device refuses is reported, its typed key stays, and nothing changes', async () => {
	const { session, device } = await open((workspace) => ({
		...workspace,
		connections: {
			...workspace.connections,
			set: async () =>
				Err('The transcription connection comes from the environment.'),
		},
	}));
	const draft = session.settings.transcription;
	draft.keyAction = 'replace';
	draft.key = 'typed-key';

	expect(await draft.save()).toEqual({
		title: 'Could not save the transcription connection',
		description: 'The transcription connection comes from the environment.',
	});
	expect(draft.key).toBe('typed-key');
	expect(draft.saving).toBe(false);
	expect(device.stored.transcription?.apiKey).toBeUndefined();
});

test.each([
	true,
	false,
])('saving another connection preserves unsaved settings with configured connections: %s', async (configured) => {
	const { session } = await open(
		undefined,
		configured ? {} : { connections: {} },
	);
	const { text, transcription } = session.settings;
	text.baseUrl = 'http://127.0.0.1:9001/v1';
	text.model = 'unsaved-text-model';
	text.keyAction = 'remove';
	transcription.model = 'changed-transcription-model';

	expect(await transcription.save()).toBeUndefined();
	expect(text.baseUrl).toBe('http://127.0.0.1:9001/v1');
	expect(text.model).toBe('unsaved-text-model');
	expect(text.keyAction).toBe('remove');
});

test('saving uses the submitted key and keeps typing done while the save is under way', async () => {
	const started = deferred<void>();
	const finish = deferred<void>();
	const changes: ConnectionChange[] = [];
	const { session } = await open((workspace) => ({
		...workspace,
		connections: {
			...workspace.connections,
			async set(operation, change) {
				changes.push(change);
				started.resolve();
				await finish.promise;
				return workspace.connections.set(operation, change);
			},
		},
	}));
	const draft = session.settings.transcription;
	draft.keyAction = 'replace';
	draft.key = 'submitted-fixture-key';
	const saving = draft.save();
	await started.promise;
	expect(draft.saving).toBe(true);
	draft.key = 'next-fixture-key';
	finish.resolve();
	expect(await saving).toBeUndefined();
	expect(changes.map((change) => change.key)).toEqual([
		{ action: 'replace', key: 'submitted-fixture-key' },
	]);
	expect(draft.key).toBe('next-fixture-key');
	expect(draft.saving).toBe(false);
});

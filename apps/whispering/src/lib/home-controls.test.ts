/**
 * Home controls tests: post-processing choice and the settings draft
 *
 * Drives a real whispering over a real directory with stubbed endpoints that
 * count every request. No component is mounted, so these establish what the
 * controls' state does and what reaches the folder and the endpoints, not how
 * the controls look.
 *
 * Key behaviors:
 * - The app starts with post-processing set to None and no transformation
 *   in the folder
 * - Choosing a transformation, recording, stopping, and transcribing send no
 *   transformation request; only an explicit run does, once
 * - A run saves a separate result file and leaves the transcript's file as
 *   it was
 * - The choice is read against the folder and the text connection by the
 *   whispering's one resolver: a deleted transformation is missing, one with no
 *   text connection to run over cannot run, and neither runs
 * - The settings form has one draft per connection: it saves the base URL,
 *   model, and key on the device only, keeps the saved key when none is
 *   typed, refuses to keep a key for another endpoint, and asks no endpoint
 *   anything
 */
import type { WhisperingContext } from './folder.js';
import {
	closeTestWhispering,
	openTestWhispering,
} from './whispering.test-support.js';

import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Err, Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import type { ConnectionChange } from './connections.js';
import { STARTER_TRANSFORMATIONS } from './definition.js';
import { settle, transformationEditor } from './edits.test-support.js';
import type { WhisperingServices } from './platform/types.js';
import { quiet } from './query.test-support.js';
import {
	deferred,
	openTestServices,
	TEST_BASE_URL,
	type TestServicesOptions,
} from './services.test-support.js';
import type { Whispering } from './whispering.svelte.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(
	change: (services: WhisperingServices) => WhisperingServices = (services) =>
		services,
	options: TestServicesOptions = {},
) {
	const test = await openTestServices(options);
	const services = change(test.services);
	const { whispering, context } = await openTestWhispering({
		...test,
		services,
	});
	cleanups.push(async () => {
		await closeTestWhispering({ whispering, context });
		await test.remove();
	});
	return {
		whispering,
		context,

		view: whispering.view,
		...test,
	};
}

const names = (root: string, directory: string) =>
	readdir(join(root, directory)).catch(() => [] as string[]);

/** Create the cleanup starter, optionally with the model a run needs. */
async function cleanup(
	whispering: Whispering,
	context: WhisperingContext,
	model?: string,
) {
	expect(
		await whispering.createTransformation(STARTER_TRANSFORMATIONS[0]!),
	).toBeUndefined();
	const draft = await transformationEditor(whispering);
	if (model !== undefined) {
		draft.edit((row) => {
			row.fields.model = model;
		});
		await settle(whispering, context);
	}
	return whispering.transformations[0]!;
}

test('the app starts with post-processing set to None and seeds no transformation', async () => {
	const { whispering, view, root, transformed } = await open();

	expect(view.postProcessing).toBeUndefined();
	expect(whispering.postProcessing).toEqual({ kind: 'none' });
	expect(whispering.transformations).toEqual([]);
	expect(await names(root, 'transformations')).toEqual([]);
	expect(transformed).toEqual([]);
});

test('choosing, recording, stopping, and transcribing send nothing to the transformation; an explicit run sends it once', async () => {
	const { context, whispering, view, root, transformed, transcribed } =
		await open();
	const profile = await cleanup(whispering, context, 'chat-model');

	view.postProcessing = profile.path;
	expect(whispering.postProcessing.kind).toBe('ready');
	await whispering.startRecording();
	await whispering.stopRecording();
	// Nothing is transcribed by recording either.
	expect(transcribed).toEqual([]);
	await whispering.transcribe(whispering.entries[0]!);
	await settle(whispering, context);

	expect(transformed).toEqual([]);
	expect(await names(root, 'transformation_runs')).toEqual([]);
	// The choice is the app's: a page change builds nothing new, so it is still chosen.
	expect(whispering.view.postProcessing).toBe(profile.path);

	const transcript = whispering.resultsFor(whispering.entries[0]!.stem)[0]!;
	const before = await readFile(join(root, transcript.path));
	expect(
		await whispering.transform(transcript.path, profile.path),
	).toBeUndefined();

	expect(transformed).toHaveLength(1);
	expect(transformed[0]).toMatchObject({
		model: 'chat-model',
		input: 'um so a steady tone\n',
	});
	expect(await names(root, 'transformation_runs')).toHaveLength(1);
	expect(whispering.outputsFor(transcript.stem)).toHaveLength(1);
	expect(whispering.recipeRuns).toEqual([]);
	expect((await readFile(join(root, transcript.path))).equals(before)).toBe(
		true,
	);
});

test('a chosen transformation with no text connection to run over cannot run, and one that was deleted is missing; neither is run', async () => {
	const { context, whispering, view, root, transformed } = await open(
		undefined,
		{
			connections: {},
		},
	);
	const profile = await cleanup(whispering, context);
	view.postProcessing = profile.path;

	// A new transformation uses the text connection, and none is set up.
	expect(whispering.postProcessing).toMatchObject({
		kind: 'repair',
		reason: 'Set up the text connection in Settings to run this.',
	});
	expect(
		await whispering.transform('transcriptions/none.md', profile.path),
	).toBe('Set up the text connection in Settings to run this.');

	await rm(join(root, profile.path));
	await settle(whispering, context);

	expect(whispering.postProcessing).toEqual({
		kind: 'missing',
		path: profile.path,
	});
	// The choice is shown as it is, not replaced.
	expect(view.postProcessing).toBe(profile.path);
	expect(transformed).toEqual([]);
});

test('the folder being read is reported while it is read, and not after', async () => {
	const { context, whispering } = await open();
	await quiet(context);
	expect(whispering.refreshing).toBe(false);

	// A change the folder reports makes the recordings stale, and they are read again.
	const reading = context.queryClient.invalidateQueries({
		queryKey: context.queries.rows('recordings').queryKey,
	});
	expect(whispering.refreshing).toBe(true);
	await reading;
	await quiet(context);

	expect(whispering.refreshing).toBe(false);
});

test('the settings draft saves a connection on the device only, keeps the saved key when none is typed, and asks no endpoint anything', async () => {
	const { whispering, root, transcribed, transformed, device } = await open(
		undefined,
		{ connections: {} },
	);
	const draft = whispering.settings.transcription;
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
	expect(whispering.connections?.transcription).toMatchObject({
		baseUrl: 'http://127.0.0.1:9000/v1',
		keyPresent: true,
	});
	// The draft follows what was saved, and the key is never read back.
	expect(draft.baseUrl).toBe('http://127.0.0.1:9000/v1');
	expect(draft.model).toBe('local-whisper');
	expect(draft.unsent).toBe(false);
	expect(draft.problem).toBeUndefined();
	expect(draft.key).toBe('');
	expect(draft.keyAction).toBe('keep');

	draft.model = 'larger-whisper';
	expect(await draft.save()).toBeUndefined();
	expect(device.stored.transcription?.apiKey).toBe('typed-key');

	// Settings reached no folder file or endpoint; only startup's ignore file exists.
	expect(await readdir(root)).toEqual(['.gitignore']);
	expect(transcribed).toEqual([]);
	expect(transformed).toEqual([]);
});

test('a changed endpoint cannot keep the saved key: the draft says why and the device refuses it', async () => {
	const { whispering, device } = await open(undefined, {
		connections: {
			text: { baseUrl: TEST_BASE_URL, model: 'chat-model', apiKey: 'text-key' },
		},
	});
	const draft = whispering.settings.text;
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
	const { whispering, device } = await open((services) => ({
		...services,
		connections: {
			...services.connections,
			set: async () =>
				Err('The transcription connection comes from the environment.'),
		},
	}));
	const draft = whispering.settings.transcription;
	draft.keyAction = 'replace';
	draft.key = 'typed-key';
	draft.baseUrl = 'http://127.0.0.1:9000/v1/';
	draft.model = ' typed-model ';

	expect(await draft.save()).toEqual({
		title: 'Could not save the transcription connection',
		description: 'The transcription connection comes from the environment.',
	});
	expect(draft.baseUrl).toBe('http://127.0.0.1:9000/v1/');
	expect(draft.model).toBe(' typed-model ');
	expect(draft.key).toBe('typed-key');
	expect(draft.keyAction).toBe('replace');
	expect(draft.unsent).toBe(true);
	expect(draft.saving).toBe(false);
	expect(device.stored.transcription?.apiKey).toBeUndefined();
});

test.each([true, false])(
	'saving another connection preserves unsaved settings with configured connections: %s',
	async (configured) => {
		const { whispering } = await open(
			undefined,
			configured ? {} : { connections: {} },
		);
		const { text, transcription } = whispering.settings;
		text.baseUrl = 'http://127.0.0.1:9001/v1';
		text.model = 'unsaved-text-model';
		text.keyAction = 'remove';
		transcription.baseUrl = 'http://127.0.0.1:9002/v1';
		transcription.model = 'changed-transcription-model';

		expect(await transcription.save()).toBeUndefined();
		expect(text.baseUrl).toBe('http://127.0.0.1:9001/v1');
		expect(text.model).toBe('unsaved-text-model');
		expect(text.keyAction).toBe('remove');
	},
);

test('saving uses the submitted key and keeps typing done while the save is under way', async () => {
	const started = deferred<void>();
	const finish = deferred<void>();
	const changes: ConnectionChange[] = [];
	const { whispering } = await open((services) => ({
		...services,
		connections: {
			...services.connections,
			async set(operation, change) {
				changes.push(change);
				started.resolve();
				await finish.promise;
				return services.connections.set(operation, change);
			},
		},
	}));
	const draft = whispering.settings.transcription;
	draft.keyAction = 'replace';
	draft.baseUrl = 'http://127.0.0.1:8100/v1/';
	draft.model = ' submitted-model ';
	draft.key = 'submitted-fixture-key';
	const saving = draft.save();
	await started.promise;
	expect(draft.saving).toBe(true);
	draft.baseUrl = 'http://127.0.0.1:8200/v1';
	draft.model = 'next-model';
	draft.key = 'next-fixture-key';
	finish.resolve();
	expect(await saving).toBeUndefined();
	expect(changes.map((change) => change.key)).toEqual([
		{ action: 'replace', key: 'submitted-fixture-key' },
	]);
	expect(draft.baseUrl).toBe('http://127.0.0.1:8200/v1');
	expect(draft.model).toBe('next-model');
	expect(draft.key).toBe('next-fixture-key');
	expect(draft.keyAction).toBe('replace');
	expect(draft.unsent).toBe(true);
	expect(draft.saving).toBe(false);
	expect(await draft.save()).toBeUndefined();
	expect(draft.unsent).toBe(false);
	expect(changes[1]).toEqual({
		baseUrl: 'http://127.0.0.1:8200/v1',
		model: 'next-model',
		key: { action: 'replace', key: 'next-fixture-key' },
	});
});

test('a newer key choice survives a save that changes whether a key is present', async () => {
	const started = deferred<void>();
	const finish = deferred<void>();
	const { whispering } = await open((services) => ({
		...services,
		connections: {
			...services.connections,
			async set(operation, change) {
				started.resolve();
				await finish.promise;
				return services.connections.set(operation, change);
			},
		},
	}));
	const draft = whispering.settings.transcription;
	draft.baseUrl = 'http://127.0.0.1:8100/v1/';
	draft.model = ' submitted-model ';
	draft.key = 'submitted-key';
	const saving = draft.save();
	await started.promise;
	draft.keyAction = 'remove';
	finish.resolve();
	expect(await saving).toBeUndefined();
	expect(draft.baseUrl).toBe('http://127.0.0.1:8100/v1');
	expect(draft.model).toBe('submitted-model');
	expect(draft.keyAction).toBe('remove');
	expect(draft.key).toBe('');
	expect(draft.unsent).toBe(true);
});

test('an untouched text endpoint follows saved transcription defaults until it is typed', async () => {
	const { whispering } = await open(undefined, { connections: {} });
	const { text, transcription } = whispering.settings;
	expect(text.baseUrl).toBe('https://api.openai.com/v1');
	transcription.baseUrl = 'http://127.0.0.1:9000/v1';
	transcription.model = 'transcription-model';
	expect(await transcription.save()).toBeUndefined();
	expect(text.baseUrl).toBe('http://127.0.0.1:9000/v1');
	expect(text.model).toBe('');
	expect(text.unsent).toBe(false);
});

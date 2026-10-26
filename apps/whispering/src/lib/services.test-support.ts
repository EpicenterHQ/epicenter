/**
 * A services for tests: a folder, a fixture capture device, and stubbed
 * endpoints. Nothing here reaches a network, a microphone, or a provider.
 *
 * The folder is the folder mirror over a real directory, opened by this test
 * process (`@epicenter/folder/bun`): the same mirror the desktop page
 * runs over a granted directory, and what a test can open without a shell.
 * A test that makes storage slow or refuse a save opens it over memory
 * instead (`@epicenter/folder/testing`), whose control does that below
 * the folder. Nothing here establishes how the Rust shell behaves.
 *
 * The endpoint stubs are plain functions, so a test decides each answer and
 * counts each request.
 */
import { mock } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Folder } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/bun';
import { createFolder, memoryHost } from '@epicenter/folder/testing';
import { svelteFolder } from '@epicenter/svelte/folder';
import { Err, Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { createFixtureDevice, toneWav } from './capture.js';
import {
	applyConnectionChange,
	type ConnectionsInfo,
	connectionInfo,
	connectionTargets,
	type Operation,
	type StoredConnection,
} from './connections.js';
import { type WhisperingTables, whisperingTables } from './definition.js';
import type { WhisperingFolder } from './folder.js';
import type { WhisperingServices } from './platform/types.js';
import { TranscriptionError } from './transcription.js';
import { TransformationError } from './transformation.js';

type TransformRequest = Parameters<WhisperingServices['transform']>[0];
type TranscribeRequest = Parameters<WhisperingServices['transcribe']>[0];

/** The base URL both stub endpoints answer at. */
export const TEST_BASE_URL = 'http://127.0.0.1:18080/v1';

/**
 * The connections a test device has set up unless a test says otherwise: a
 * keyless local endpoint for each, as a person would configure on purpose.
 */
export const TEST_CONNECTIONS: Record<Operation, StoredConnection> = {
	transcription: { baseUrl: TEST_BASE_URL, model: 'verification-model' },
	text: { baseUrl: TEST_BASE_URL, model: 'connection-model' },
};

/**
 * A device's connections, kept in memory by the same rules the host and the
 * browser apply to their storage. `stored` holds the keys, so a test can see
 * where one went; the services member answers as a services does, never
 * with a key.
 */
export function testConnections({
	connections = TEST_CONNECTIONS,
	readOnly = {},
}: {
	connections?: Partial<Record<Operation, StoredConnection>>;
	readOnly?: Partial<Record<Operation, string>>;
} = {}) {
	const stored: Partial<Record<Operation, StoredConnection>> = {
		...connections,
	};
	const info = (): ConnectionsInfo => ({
		transcription:
			stored.transcription &&
			connectionInfo(stored.transcription, readOnly.transcription),
		text: stored.text && connectionInfo(stored.text, readOnly.text),
	});
	const member: WhisperingServices['connections'] = {
		storedIn: 'test',
		defaults: {
			transcription: {
				baseUrl: 'https://api.openai.com/v1',
				model: 'whisper-1',
			},
			text: { baseUrl: 'https://api.openai.com/v1', model: '' },
		},
		read: async () => info(),
		async set(operation, change) {
			const reason = readOnly[operation];
			if (reason !== undefined) return Err(reason);
			const { data: next, error: changeError } = applyConnectionChange(
				operation,
				stored[operation],
				change,
			);
			if (changeError !== null) return Err(changeError);
			stored[operation] = next;
			return Ok(info());
		},
	};
	return { stored, member };
}

/**
 * Whether a prepared request would go out over the connection stored now,
 * as the host and the browser decide it: undefined when it would.
 */
function refusedConnection(
	stored: StoredConnection | undefined,
	expectedBaseUrl: string,
):
	| { readonly kind: 'missing' }
	| { readonly kind: 'changed'; readonly configured: string }
	| undefined {
	if (stored === undefined) return { kind: 'missing' };
	if (!connectionTargets(stored, expectedBaseUrl))
		return { kind: 'changed', configured: stored.baseUrl };
	return undefined;
}

/**
 * A new directory named as Whispering's own folder in an earlier layout,
 * `so.epicenter.whispering`, in a temporary directory of its own. Remove
 * `dirname` of it when done.
 */
export async function whisperingDirectory(prefix: string) {
	const root = join(
		await realpath(await mkdtemp(join(tmpdir(), prefix))),
		'so.epicenter.whispering',
	);
	await mkdir(root);
	return root;
}

/** An opened test folder: what the app is given, and the folder under it. */
export type TestFolder = {
	/** The folder read reactively, as `<OpenFolder>` hands it to the app. */
	readonly folder: WhisperingFolder;
	/** The folder under it: what `<OpenFolder>` opens and closes. */
	readonly opened: Folder<WhisperingTables>;
};

function wrap(opened: Folder<WhisperingTables>): TestFolder {
	return {
		folder: svelteFolder(opened),
		opened,
	};
}

/** A real directory opened with Whispering's tables, by this test process. */
export async function openTestFolder(
	root: string,
): Promise<TestFolder> {
	return wrap(
		expectOk(
			await openFolder({
				directory: root,
				tables: whisperingTables,
			}),
		),
	);
}

/**
 * A folder over memory, with what it starts with. `host.control` makes
 * storage slow or refuse a save below the folder (`putGate`, `failPut`,
 * `beforePut`), and `host.text(path)` reads what landed.
 */
export async function openMemoryTestFolder(
	initial: Record<string, string | Uint8Array> = {},
) {
	const host = memoryHost(initial);
	const opened = expectOk(
		await createFolder(host.storage, { tables: whisperingTables }),
	);
	return { ...wrap(opened), host };
}

export type TestServicesOptions = {
	/** Replace the stubbed transcription answer. */
	transcribe?: WhisperingServices['transcribe'];
	/** Replace the stubbed transformation answer. */
	transform?: WhisperingServices['transform'];
	/** What the device has set up. Both connections, keyless, unless a test says otherwise. */
	connections?: Partial<Record<Operation, StoredConnection>>;
	/** Use this folder instead of opening the test's directory. */
	folder?: TestFolder;
};

export async function openTestServices({
	transcribe,
	transform,
	connections,
	folder: given,
}: TestServicesOptions = {}) {
	const root = await whisperingDirectory('whispering-services-');
	const { folder, opened } = given ?? (await openTestFolder(root));
	const device = testConnections({ connections });

	const transformed: TransformRequest[] = [];
	const transcribed: TranscribeRequest[] = [];
	let opens = 0;
	let closes = 0;

	const close = opened.close.bind(opened);
	opened.close = async () => {
		closes++;
		return await close();
	};
	const services: WhisperingServices = {
		kind: 'native',

		location: root,
		capture: createFixtureDevice({
			name: 'tone.wav',
			load: async () => ({ name: 'tone.wav', bytes: toneWav() }),
		}),
		recoverRecordings: async () => undefined,
		// Each stub decides the connection as the host does, at entry, and only a
		// request that would go out is counted as sent.
		async transcribe(request) {
			const refused = refusedConnection(
				device.stored.transcription,
				request.expectedBaseUrl,
			);
			if (refused?.kind === 'missing')
				return TranscriptionError.ConnectionUnavailable({
					reason: 'no transcription connection is set up.',
				});
			if (refused?.kind === 'changed')
				return TranscriptionError.ConnectionChanged({
					expected: request.expectedBaseUrl,
					configured: refused.configured,
				});
			transcribed.push(request);
			if (transcribe !== undefined) return transcribe(request);
			return Ok({ text: 'um so a steady tone' });
		},
		async transform(request) {
			const refused = refusedConnection(
				device.stored.text,
				request.expectedBaseUrl,
			);
			if (refused?.kind === 'missing')
				return TransformationError.ConnectionUnavailable({
					reason: 'no text connection is set up.',
				});
			if (refused?.kind === 'changed')
				return TransformationError.ConnectionChanged({
					expected: request.expectedBaseUrl,
					configured: refused.configured,
				});
			transformed.push(request);
			if (transform !== undefined) return transform(request);
			return Ok({ text: `Transformed: ${request.input.trim()}` });
		},
		transformNote: 'test',
		localTranscription: undefined,
		connections: device.member,
		preferences: {
			microphone: async () => undefined,
			setMicrophone: async () => undefined,
		},
	};

	return {
		root,
		/** The folder the app is given. */
		folder,
		/** The folder under it, which `<OpenFolder>` opens and closes. */
		opened,
		/** Every write that did not land, in order. */
		services,
		/** What `<OpenFolder>` is given: it counts how many times a folder was opened. */
		open: async () => {
			opens += 1;
			return Ok(opened);
		},
		/** Every transformation request the endpoint stub received, in order. */
		transformed,
		/** Every transcription request the endpoint stub received, in order. */
		transcribed,
		/** The device's stored connections, keys included. */
		device,
		get opens() {
			return opens;
		},
		get closes() {
			return closes;
		},
		/** Close the folder, sending what waits, and remove the directory. */
		async remove() {
			await close();
			await rm(dirname(root), { recursive: true, force: true });
		},
	};
}

/** Wait until the folder sends nothing more: every write landed or answered. */
export async function waitForSaves(folder: WhisperingFolder) {
	await eventually(() => !folder.saving);
	// The answers resolve right after the last save leaves the queue.
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A promise a test settles by hand, to hold a request open. */
export function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** Wait until `check` holds, as work the test does not await lands. */
export async function eventually(check: () => boolean, timeoutMs = 4000) {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('It never happened.');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Per-folder device doubles used by the actual product constructor. */
const providedServices = new WeakMap<WhisperingFolder, WhisperingServices>();
/** The doubles for a folder the test never sees, as `<OpenFolder>` wraps its own. */
let anyFolderServices: WhisperingServices | undefined;
let installedServices = false;
/** Give the product these doubles for `folder`, or for whatever folder it opens (`'any'`). */
export function provideServices(
	folder: WhisperingFolder | 'any',
	services: WhisperingServices,
) {
	if (folder === 'any') anyFolderServices = services;
	else providedServices.set(folder, services);
	if (installedServices) return;
	installedServices = true;
	mock.module('#platform/services', () => ({
		createServices(folder: WhisperingFolder): WhisperingServices {
			const services = providedServices.get(folder) ?? anyFolderServices;
			if (services === undefined)
				throw new Error('No test services were provided for this folder');
			return services;
		},
	}));
}

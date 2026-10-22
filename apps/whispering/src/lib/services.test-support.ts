/**
 * A services for tests: a real directory, a fixture capture device, and
 * stubbed endpoints. Nothing here reaches a network, a microphone, or a
 * provider.
 *
 * The folder is the native `Folder` over a directory, opened by this test
 * process (`openBunFolder`): the same folder engine the desktop page runs
 * over a granted directory, over the same kind of directory, and what a test
 * can open without a shell. Nothing here establishes how the Rust shell
 * behaves.
 *
 * The endpoint stubs are plain functions, so a test decides each answer and
 * counts each request.
 */
import { mock } from 'bun:test';
import { mkdirSync, rmdirSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FolderTable } from '@epicenter/folder';
import { Err, Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { FileError } from '../../../../packages/folder/src/errors.js';
// The Bun directory opener is not a public entry yet; tests reach it here.
import { openBunFolder } from '../../../../packages/folder/src/native/bun.js';
import { createNativeFolder } from '../../../../packages/folder/src/native/engine.js';
import { nativeStorage } from '../../../../packages/folder/src/native/storage.js';
import { createFixtureDevice, toneWav } from './capture.js';
import {
	applyConnectionChange,
	type ConnectionsInfo,
	connectionInfo,
	connectionTargets,
	type Operation,
	type StoredConnection,
} from './connections.js';
import { whisperingTables } from './definition.js';
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

/** A real directory opened with Whispering's tables, by this test process. */
export async function openTestFolder(root: string): Promise<WhisperingFolder> {
	return expectOk(
		await openBunFolder({ directory: root, tables: whisperingTables }),
	);
}

/**
 * The directory at `root`, a resolved path such as `whisperingDirectory`
 * answers, opened as the native folder over its real storage, with every
 * write of a file's bytes, or removal, first passing `gate`, as a slow or
 * refusing disk would. `gate` answers why the disk refuses, or nothing.
 * Below the handle, so a save the folder's edit owner sends meets it too.
 */
export function openGatedTestFolder(
	root: string,
	gate: (path: string) => Promise<unknown>,
): WhisperingFolder {
	const storage = nativeStorage(root);
	return createNativeFolder({
		storage: {
			...storage,
			async put(path, bytes, ifMatch) {
				const refused = await gate(path);
				if (refused !== undefined)
					return FileError.Io({ path, operation: 'write', cause: refused });
				return storage.put(path, bytes, ifMatch);
			},
		},
		tables: whisperingTables,
		directory: `bun:${root}`,
	});
}

/**
 * A table whose next new rows find an empty directory where the row's file
 * goes, as many times as `failures.creates` says. Nothing is answered on the
 * folder's behalf: the folder refuses the obstructed save itself, as it
 * would on a real disk, and the directory is removed after. `directory` is
 * the table's directory on disk. A test may arm more after opening.
 */
export function withObstructedCreates<TTable extends FolderTable>(
	table: TTable,
	directory: string,
	failures: { creates: number },
): TTable {
	return {
		...table,
		async write(id, change) {
			if (change.body !== '' || failures.creates === 0)
				return table.write(id, change);
			failures.creates -= 1;
			const obstacle = join(directory, `${id}.md`);
			mkdirSync(obstacle, { recursive: true });
			try {
				return await table.write(id, change);
			} finally {
				rmdirSync(obstacle);
			}
		},
	};
}

export type TestServicesOptions = {
	/** Replace the stubbed transcription answer. */
	transcribe?: WhisperingServices['transcribe'];
	/** Replace the stubbed transformation answer. */
	transform?: WhisperingServices['transform'];
	/** Fail this many result rows written when a run starts, in any result table. */
	failResultStarts?: number;
	/** Fail this many answer deliveries before the Folder accepts input. */
	failAnswerWrites?: number;
	/** What the device has set up. Both connections, keyless, unless a test says otherwise. */
	connections?: Partial<Record<Operation, StoredConnection>>;
	/** Pause real storage listings beneath the Folder handle. */
	beforeStorageList?: () => Promise<void>;
	/** Open this folder instead of a directory with the Bun opener. */
	folder?: WhisperingFolder;
};

/** Result row writes still to fail: rows written when a run starts, and answers written into them. */
export type ResultFailures = { starts: number; answers: number };

/**
 * A result table whose next new rows fail before writing, as many times as
 * `failures.starts` says. The next `failures.answers` calls to save an answer
 * throw before reaching the Folder and accepting input. To fail a publication
 * after acceptance, use `openGatedTestFolder` below the handle. A test may arm
 * more failures after opening.
 */
export function withResultFailures<TTable extends FolderTable>(
	table: TTable,
	failures: ResultFailures,
): TTable {
	const refused = () =>
		Err({
			name: 'StorageFailed' as const,
			message: 'Repository save failed: the disk refused the result',
			cause: new Error('the disk refused the result'),
		});
	return {
		...table,
		async write(id, change) {
			if (failures.starts === 0) return table.write(id, change);
			failures.starts -= 1;
			return refused();
		},
		document(id) {
			const document = table.document(id);
			return {
				...document,
				async save(change) {
					if (failures.answers === 0) return document.save(change);
					failures.answers -= 1;
					// A failure before calling the Folder has accepted no input.
					// Storage failures after acceptance belong below the handle.
					throw new Error(
						'Repository save failed: the disk refused the result',
					);
				},
			};
		},
	};
}

/**
 * Replace some of `folder`'s tables, and its files, in place, and answer the
 * same handle. The app's own calls meet the replacements. The folder's edit
 * owner keeps saving through the handle's storage, so a refusal it should
 * meet belongs below the handle (`openGatedTestFolder`).
 */
export function replaceTables(
	folder: WhisperingFolder,
	tables: Partial<WhisperingFolder['tables']>,
	files: WhisperingFolder['files'] = folder.files,
): WhisperingFolder {
	Object.assign(folder.tables, tables);
	Object.assign(folder, { files });
	return folder;
}

export async function openTestServices({
	transcribe,
	transform,
	failResultStarts = 0,
	failAnswerWrites = 0,
	connections,
	folder: given,
	beforeStorageList,
}: TestServicesOptions = {}) {
	const root = await whisperingDirectory('whispering-services-');
	const storage = nativeStorage(root);
	let folder =
		given ??
		(beforeStorageList === undefined
			? await openTestFolder(root)
			: createNativeFolder({
					storage: {
						...storage,
						async list() {
							await beforeStorageList();
							return storage.list();
						},
					},
					tables: whisperingTables,
					directory: `bun:${root}`,
				}));
	const failures: ResultFailures = {
		starts: failResultStarts,
		answers: failAnswerWrites,
	};
	const device = testConnections({ connections });

	const transformed: TransformRequest[] = [];
	const transcribed: TranscribeRequest[] = [];
	let opens = 0;
	let closes = 0;

	folder = replaceTables(folder, {
		transcriptions: withResultFailures(folder.tables.transcriptions, failures),
		transformation_runs: withResultFailures(
			folder.tables.transformation_runs,
			failures,
		),
		text_runs: withResultFailures(folder.tables.text_runs, failures),
	});
	const closeFolder = folder.close.bind(folder);
	folder.close = async () => {
		closes++;
		return await closeFolder();
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
		folder,
		services,
		/** Result row writes still to fail; a test may arm more. */
		failures,
		/** What `FolderApp` is given: it counts how many times a folder was opened. */
		open: async () => {
			opens += 1;
			return Ok(folder);
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
		remove: () => rm(dirname(root), { recursive: true, force: true }),
	};
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
let installedServices = false;
export function provideServices(
	folder: WhisperingFolder,
	services: WhisperingServices,
) {
	providedServices.set(folder, services);
	if (installedServices) return;
	installedServices = true;
	mock.module('#platform/services', () => ({
		createServices(folder: WhisperingFolder): WhisperingServices {
			const services = providedServices.get(folder);
			if (services === undefined)
				throw new Error('No test services were provided for this folder');
			return services;
		},
	}));
}

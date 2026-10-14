/**
 * A workspace for tests: a real directory and Git repository, a fixture
 * capture device, and stubbed endpoints. Nothing here reaches a network, a
 * microphone, or a provider.
 *
 * The folder is opened with the Bun directory opener. It keeps the same
 * contract as the desktop shell's owner over the same kind of directory, and
 * is what a test can open without a shell. It is not that owner: nothing here
 * establishes how the Rust owner behaves.
 *
 * The endpoint stubs are plain functions, so a test decides each answer and
 * counts each request.
 */
import { mkdirSync, rmdirSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileError, type FileTable, openFolder } from '@epicenter/folder/bun';
import { Err, Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { createFixtureDevice, toneWav } from './capture.js';
import {
	adoptLegacyKey,
	applyConnectionChange,
	type ConnectionsInfo,
	connectionInfo,
	connectionTargets,
	OPERATIONS,
	type Operation,
	type StoredConnection,
} from './connections.js';
import { whisperingDefinition } from './definition.js';
import { TranscriptionError } from './transcription.js';
import { TransformationError } from './transformation.js';
import type {
	CloseDecision,
	RecordingWriteHook,
	Workspace,
} from './workspace/types.js';

type TransformRequest = Parameters<Workspace['transform']>[0];
type TranscribeRequest = Parameters<Workspace['transcribe']>[0];

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
 * where one went; the workspace member answers as a workspace does, never
 * with a key.
 */
export function testConnections({
	connections = TEST_CONNECTIONS,
	legacyKey = '',
	readOnly = {},
}: {
	connections?: Partial<Record<Operation, StoredConnection>>;
	legacyKey?: string;
	readOnly?: Partial<Record<Operation, string>>;
} = {}) {
	const stored: Partial<Record<Operation, StoredConnection>> = {
		...connections,
	};
	const device = { legacyKey };
	const info = (): ConnectionsInfo => ({
		transcription:
			stored.transcription &&
			connectionInfo(stored.transcription, readOnly.transcription),
		text: stored.text && connectionInfo(stored.text, readOnly.text),
		legacyKey: device.legacyKey !== '',
	});
	const member: Workspace['connections'] = {
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
		async adoptLegacyKey(targets) {
			const { data: adopted, error: adoptError } = adoptLegacyKey(
				device.legacyKey,
				targets,
				readOnly,
			);
			if (adoptError !== null) return Err(adoptError);
			for (const operation of OPERATIONS)
				if (adopted[operation] !== undefined)
					stored[operation] = adopted[operation];
			device.legacyKey = '';
			return Ok(info());
		},
	};
	return { stored, device, member };
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

/** A real directory opened as Whispering's folder, by this test process. */
export async function openTestFolder(root: string) {
	return expectOk(
		await openFolder({
			root,
			definition: whisperingDefinition,
			git: { author: { name: 'Test', email: 'test@localhost' } },
		}),
	);
}

/** How many upcoming recording writes fail, by step. */
export type RecordingFailures = {
	/** Audio writes: nothing of that attempt reaches the folder. */
	audio: number;
	/** Row writes: the audio the attempt wrote before stays. */
	row: number;
};

/**
 * What a debug desktop shell does around each write of a recording's
 * publication, in this process: while `failures` has any left for the
 * write's step, an empty directory is put where that write goes and removed
 * after it. Nothing is answered on the folder's behalf; the folder refuses the
 * obstructed write itself, as it would on a real disk.
 */
export function recordingWriteFailures(
	root: string,
	failures: RecordingFailures,
): RecordingWriteHook {
	return async (write, run) => {
		let obstacle: string | undefined;
		if (failures[write.step] > 0) {
			failures[write.step] -= 1;
			obstacle = join(
				root,
				write.step === 'audio' ? write.path : `recordings/${write.stem}.md`,
			);
			mkdirSync(obstacle, { recursive: true });
		}
		try {
			return await run();
		} finally {
			if (obstacle !== undefined) rmdirSync(obstacle);
		}
	};
}

/** A debug shell's injection whose only armed failures are recording writes. */
export function testInjection(
	root: string,
	failures: RecordingFailures,
): NonNullable<Workspace['injection']> {
	const state = () => ({
		rowWrites: failures.row,
		audioWrites: failures.audio,
		commitsBlocked: false,
	});
	return {
		state: async () => state(),
		async arm(change) {
			failures.row = change.rowWrites ?? failures.row;
			failures.audio = change.audioWrites ?? failures.audio;
			return state();
		},
		aroundRecordingWrite: recordingWriteFailures(root, failures),
	};
}

export type TestWorkspaceOptions = {
	/** Replace the stubbed transcription answer. */
	transcribe?: Workspace['transcribe'];
	/** Replace the stubbed transformation answer. */
	transform?: Workspace['transform'];
	/** Fail this many recording saves before any file is written, so the capture stays pending. */
	failAudioWrites?: number;
	/** Fail this many recording saves at the row, after the audio is written. */
	failRowWrites?: number;
	/** Fail this many transformation result writes before any byte is written. */
	failRunWrites?: number;
	/** Report this many transformation result writes as failed after the file landed. */
	loseRunWriteAnswers?: number;
	/** Fail this many writes of results on pasted text before any byte is written. */
	failTextRunWrites?: number;
	/** Report this many writes of results on pasted text as failed after the file landed. */
	loseTextRunWriteAnswers?: number;
	/** What the device has set up. Both connections, keyless, unless a test says otherwise. */
	connections?: Partial<Record<Operation, StoredConnection>>;
	/** A key an earlier build saved on the device. */
	legacyKey?: string;
	/** Open this folder instead of a directory with the Bun opener, such as a browser folder. */
	folder?: Workspace['folder'] & { close(): Promise<void> };
};

/**
 * A result table whose next creates fail before writing, or land and then
 * answer as failed, as many times as `counts` says.
 */
function withWriteFailures<TFields>(
	table: FileTable<TFields>,
	counts: { fail: number; lose: number },
): FileTable<TFields> {
	const refused = (stem: string | undefined) =>
		FileError.Io({
			path: `${table.name}/${stem}.md`,
			operation: 'create',
			cause: new Error('disk refused the result'),
		});
	return {
		...table,
		async create(row, options) {
			if (counts.fail > 0) {
				counts.fail -= 1;
				return refused(options?.stem);
			}
			const created = await table.create(row, options);
			if (counts.lose > 0 && created.error === null) {
				counts.lose -= 1;
				return refused(options?.stem);
			}
			return created;
		},
	};
}

export async function openTestWorkspace({
	transcribe,
	transform,
	failAudioWrites = 0,
	failRowWrites = 0,
	failRunWrites = 0,
	loseRunWriteAnswers = 0,
	failTextRunWrites = 0,
	loseTextRunWriteAnswers = 0,
	connections,
	legacyKey,
	folder: given,
}: TestWorkspaceOptions = {}) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-workspace-')),
	);
	const folder = given ?? (await openTestFolder(root));
	const tables = {
		...folder.tables,
		transformation_runs: withWriteFailures(folder.tables.transformation_runs, {
			fail: failRunWrites,
			lose: loseRunWriteAnswers,
		}),
		text_runs: withWriteFailures(folder.tables.text_runs, {
			fail: failTextRunWrites,
			lose: loseTextRunWriteAnswers,
		}),
	};
	const device = testConnections({ connections, legacyKey });

	const transformed: TransformRequest[] = [];
	const transcribed: TranscribeRequest[] = [];
	const answers: CloseDecision[] = [];
	const closeListeners = new Set<() => void>();
	/** A close the shell asked for while nothing was listening. */
	let closeAsked = false;
	const terminalRuns: string[] = [];
	let cwd = '/';
	let opens = 0;
	let closes = 0;

	const workspace: Workspace = {
		kind: 'native',
		folder: { ...folder, tables } as Workspace['folder'],
		location: root,
		terminal: {
			get cwd() {
				return cwd;
			},
			async exec(command) {
				terminalRuns.push(command);
				if (command.startsWith('cd ')) cwd = `/${command.slice(3)}`;
				return { stdout: `ran ${command}\n`, stderr: '', exitCode: 0 };
			},
			note: 'test',
		},
		capture: createFixtureDevice({
			name: 'tone.wav',
			load: async () => ({ name: 'tone.wav', bytes: toneWav() }),
		}),
		captureNotice: undefined,
		reveal: undefined,
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
		closing: {
			// As the desktop workspace does: a request with nobody listening is
			// kept and handed to the first listener.
			onRequest(listener) {
				closeListeners.add(listener);
				if (closeAsked) {
					closeAsked = false;
					listener();
				}
				return () => closeListeners.delete(listener);
			},
			async answer(decision) {
				answers.push(decision);
			},
			onRequestWithoutHost: () => () => {},
			quitWithoutHost() {},
		},
		connections: device.member,
		preferences: {
			microphone: async () => undefined,
			setMicrophone: async () => undefined,
		},
		debugControls: true,
		injection:
			failAudioWrites > 0 || failRowWrites > 0
				? testInjection(root, { audio: failAudioWrites, row: failRowWrites })
				: undefined,
		async close() {
			closes += 1;
			await folder.close();
		},
	};

	return {
		root,
		workspace,
		/** What `openSession` is given: it counts how many times a folder was opened. */
		open: async () => {
			opens += 1;
			return Ok(workspace);
		},
		/** Every transformation request the endpoint stub received, in order. */
		transformed,
		/** Every transcription request the endpoint stub received, in order. */
		transcribed,
		/** The device's stored connections, keys included, and its earlier key. */
		device,
		answers,
		closeListeners,
		/** The shell asks to close, as the workspace delivers it: now, or kept. */
		requestClose() {
			if (closeListeners.size === 0) closeAsked = true;
			for (const listener of closeListeners) listener();
		},
		terminalRuns,
		get opens() {
			return opens;
		},
		get closes() {
			return closes;
		},
		remove: () => rm(root, { recursive: true, force: true }),
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

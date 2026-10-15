/**
 * A workspace for tests: a real directory and Git repository, a fixture
 * capture device, and stubbed endpoints. Nothing here reaches a network, a
 * microphone, or a provider.
 *
 * The folder is opened with the Bun directory opener: the same folder engine
 * the desktop page runs over a granted directory, over the same kind of
 * directory, and what a test can open without a shell. Nothing here
 * establishes how the Rust shell behaves.
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
import type { RecordingWriteHook, Workspace } from './workspace/types.js';

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
	/** Audio writes on stop: the row stays without its audio. */
	audio: number;
	/** Row writes on start: the recording runs, and no row names its audio. */
	row: number;
};

/**
 * What a debug desktop shell does around each write of a recording, in this
 * process: while `failures` has any left for the
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
	/** Fail this many recording audio writes, made when a fixture recording stops. */
	failAudioWrites?: number;
	/** Fail this many recording row writes, made when a recording starts. */
	failRowWrites?: number;
	/** Fail this many result rows written when a run starts, in any result table. */
	failResultStarts?: number;
	/** Fail this many answers written into result rows, in any result table. */
	failAnswerWrites?: number;
	/** What the device has set up. Both connections, keyless, unless a test says otherwise. */
	connections?: Partial<Record<Operation, StoredConnection>>;
	/** A key an earlier build saved on the device. */
	legacyKey?: string;
	/** Open this folder instead of a directory with the Bun opener, such as a browser folder. */
	folder?: Workspace['folder'] & { close(): Promise<void> };
};

/** Result row writes still to fail: rows written when a run starts, and answers written into them. */
export type ResultFailures = { starts: number; answers: number };

const refusedResult = (path: string, operation: 'create' | 'write') =>
	FileError.Io({
		path,
		operation,
		cause: new Error('disk refused the result'),
	});

/**
 * A result table whose next creates fail before writing, as many times as
 * `failures.starts` says, and whose next answers fail the same way, as many
 * times as `failures.answers` says. An answer fills its row through a save
 * that does not merge. A test may arm more after opening.
 */
export function withResultFailures<TFields>(
	table: FileTable<TFields>,
	failures: ResultFailures,
): FileTable<TFields> {
	return {
		...table,
		async create(row, options) {
			if (failures.starts === 0) return table.create(row, options);
			failures.starts -= 1;
			return refusedResult(`${table.name}/${options?.stem}.md`, 'create');
		},
		async save(file, row, options) {
			if (options?.merge !== false || failures.answers === 0)
				return table.save(file, row, options);
			failures.answers -= 1;
			return refusedResult(file.path, 'write');
		},
	};
}

export async function openTestWorkspace({
	transcribe,
	transform,
	failAudioWrites = 0,
	failRowWrites = 0,
	failResultStarts = 0,
	failAnswerWrites = 0,
	connections,
	legacyKey,
	folder: given,
}: TestWorkspaceOptions = {}) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-workspace-')),
	);
	const folder = given ?? (await openTestFolder(root));
	const failures: ResultFailures = {
		starts: failResultStarts,
		answers: failAnswerWrites,
	};
	const tables = {
		...folder.tables,
		transcriptions: withResultFailures(folder.tables.transcriptions, failures),
		transformation_runs: withResultFailures(
			folder.tables.transformation_runs,
			failures,
		),
		text_runs: withResultFailures(folder.tables.text_runs, failures),
	};
	const device = testConnections({ connections, legacyKey });

	const transformed: TransformRequest[] = [];
	const transcribed: TranscribeRequest[] = [];
	const terminalRuns: string[] = [];
	let cwd = '/';
	let opens = 0;
	let closes = 0;

	const workspace: Workspace = {
		kind: 'native',
		folder: {
			...folder,
			tables,
		} as Workspace['folder'],
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
		/** Result row writes still to fail; a test may arm more. */
		failures,
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

/** Wait until `check` holds, as work the test does not await lands. */
export async function eventually(check: () => boolean, timeoutMs = 4000) {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('It never happened.');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

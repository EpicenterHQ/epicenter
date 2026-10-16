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
 * Connections are real: rows of a real `so.epicenter` folder in its own
 * directory, keys in memory, and requests sent by `sendRequest` from
 * `@epicenter/ai/send`, so the endpoint pinning and key checks a test sees are
 * the shipped ones. Only the endpoint is a stub: a plain function, so a test
 * decides each answer and counts each request.
 */
import { mkdirSync, rmdirSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { epicenterDefinition } from '@epicenter/ai/connection-table';
import {
	type ConnectionKind,
	createMemorySecrets,
	type SecretStore,
	sendRequest,
} from '@epicenter/ai/send';
import { browserKeys } from '@epicenter/ai/ui';
import { FileError, type FileTable, openFolder } from '@epicenter/folder/bun';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { createFixtureDevice, toneWav } from './capture.js';
import type { Operation } from './connection-routes.js';
import { whisperingDefinition } from './definition.js';
import type { LocalTranscription } from './workspace/local-transcription.js';
import {
	type RecordingWriteHook,
	WHISPERING_FOLDER_ID,
	type Workspace,
	type WorkspaceConnections,
} from './workspace/types.js';

/** The endpoint both stub connections send to. */
export const TEST_BASE_URL = 'http://127.0.0.1:18080/v1';

/** A connection a test device has: its row, and for an endpoint, what is saved for it. */
export type TestConnection = {
	readonly kind?: ConnectionKind;
	readonly title?: string;
	readonly model: string;
	/** Saved for an `openai-compatible` row; `TEST_BASE_URL` unless a test says otherwise. */
	readonly endpoint?: string;
	readonly key?: string;
};

/** The ids of the rows a test device starts with, one chosen for each operation. */
export const TEST_CONNECTION_IDS: Record<Operation, string> = {
	transcription: 'test-transcription',
	text: 'test-text',
};

/**
 * The connections a test device has unless a test says otherwise: a keyless
 * local endpoint for each, chosen for its operation.
 */
export const TEST_CONNECTIONS: Record<Operation, TestConnection> = {
	transcription: { title: 'Test transcription', model: 'verification-model' },
	text: { title: 'Test text', model: 'connection-model' },
};

type Received = {
	readonly connection: string;
	readonly endpoint: string;
	readonly model: string;
};
/** A transcription the stub endpoint received, with its uploaded file's name. */
export type Transcribed = Received & { readonly audio: string };
/** A chat completion the stub endpoint received. */
export type Transformed = Received & {
	readonly prompt: string;
	readonly input: string;
};
/** What the stub endpoint answers: the text, a refusal before anything is sent, or the response itself. */
export type StubAnswer =
	| Result<{ text: string }, { message: string }>
	| Response;
type Answer = StubAnswer;

/**
 * A device's connections: rows of a real `so.epicenter`, keys in `secrets`,
 * and a stub endpoint behind `sendRequest`. `answer` decides each request
 * that reaches it; one that `send.ts` refuses never does.
 */
export async function testConnections({
	root,
	connections = TEST_CONNECTIONS,
	others = {},
	epicenterEndpoint,
	local,
	answer,
}: {
	root: string;
	connections?: Partial<Record<Operation, TestConnection | null>>;
	/** More rows, by id, that no operation names. */
	others?: Record<string, TestConnection>;
	/** The signed-in account's `/v1`; absent, an Epicenter row cannot send. */
	epicenterEndpoint?: string;
	local?: LocalTranscription;
	answer: (
		request:
			| ({ readonly path: 'audio/transcriptions' } & Transcribed)
			| ({ readonly path: 'chat/completions' } & Transformed),
	) => Promise<Answer>;
}) {
	const folder = expectOk(
		await openFolder({
			root,
			definition: epicenterDefinition,
			git: { author: { name: 'Test', email: 'test@localhost' } },
		}),
	);
	const secrets: SecretStore = createMemorySecrets();
	const keys = browserKeys(secrets);
	const rows = [
		...(['transcription', 'text'] as const).flatMap((operation) => {
			const connection = connections[operation];
			return connection
				? [[TEST_CONNECTION_IDS[operation], connection] as const]
				: [];
		}),
		...Object.entries(others),
	];
	for (const [id, connection] of rows) {
		const kind = connection.kind ?? 'openai-compatible';
		expectOk(
			await folder.tables.connections.create(
				{
					fields: {
						kind,
						title: connection.title ?? id,
						model: connection.model,
					},
					body: '',
				},
				{ stem: id },
			),
		);
		if (kind === 'openai-compatible')
			expectOk(
				await keys.save(
					id,
					connection.endpoint ?? TEST_BASE_URL,
					connection.key ?? '',
				),
			);
	}

	/** The stub endpoint, recording what reached it for `target`. */
	function endpointFor(connection: string) {
		let refusal: { message: string } | undefined;
		const fetch = async (input: string | URL | Request, init?: RequestInit) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			let answered: Answer;
			if (url.pathname.endsWith('/audio/transcriptions')) {
				const form = await request.formData();
				answered = await answer({
					path: 'audio/transcriptions',
					connection,
					endpoint: url.href.slice(0, -'/audio/transcriptions'.length),
					model: String(form.get('model')),
					audio: (form.get('file') as File).name,
				});
				if (answered instanceof Response) return answered;
				if (answered.error !== null) {
					refusal = answered.error;
					return new Response('', { status: 599 });
				}
				return Response.json({ text: answered.data.text });
			}
			const body = (await request.json()) as {
				model: string;
				messages: { content: string }[];
			};
			answered = await answer({
				path: 'chat/completions',
				connection,
				endpoint: url.href.slice(0, -'/chat/completions'.length),
				model: body.model,
				prompt: body.messages[0]?.content ?? '',
				input: body.messages[1]?.content ?? '',
			});
			if (answered instanceof Response) return answered;
			if (answered.error !== null) {
				refusal = answered.error;
				return new Response('', { status: 599 });
			}
			return Response.json({
				choices: [{ message: { content: answered.data.text } }],
			});
		};
		return { fetch, refusal: () => refusal };
	}

	const member: WorkspaceConnections = {
		kinds: ['openai-compatible', 'epicenter', 'local'],
		keys,
		epicenterNote: 'test',
		note: 'test',
		open: async () => Ok(folder),
		epicenterEndpoint: async () =>
			epicenterEndpoint === undefined
				? Err('not signed in')
				: Ok(epicenterEndpoint),
		async send(target, request) {
			const stub = endpointFor(target.connection);
			const { data: response, error } = await sendRequest({
				target,
				request,
				secrets,
				...(epicenterEndpoint !== undefined && {
					epicenter: async () =>
						Ok({ endpoint: epicenterEndpoint, key: '', fetch: stub.fetch }),
				}),
				fetch: stub.fetch,
			});
			const refused = stub.refusal();
			if (refused !== undefined) return Err(refused);
			if (error !== null) return Err(error);
			return Ok(response);
		},
	};
	return { folder, secrets, keys, member, local };
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
	/** Replace the stub endpoint's transcription answer. */
	transcribe?: (request: Transcribed) => Promise<Answer>;
	/** Replace the stub endpoint's chat answer. */
	transform?: (request: Transformed) => Promise<Answer>;
	/** Fail this many recording audio writes, made when a fixture recording stops. */
	failAudioWrites?: number;
	/** Fail this many recording row writes, made when a recording starts. */
	failRowWrites?: number;
	/** Fail this many result rows written when a run starts, in any result table. */
	failResultStarts?: number;
	/** Fail this many answers written into result rows, in any result table. */
	failAnswerWrites?: number;
	/**
	 * The connection each operation uses: a row chosen for it, both keyless
	 * endpoints unless a test says otherwise. `null` is none, and none chosen.
	 */
	connections?: Partial<Record<Operation, TestConnection | null>>;
	/** More connection rows, by id, that no operation names. */
	others?: Record<string, TestConnection>;
	/** The signed-in account's `/v1`, for an Epicenter connection. */
	epicenterEndpoint?: string;
	/** Transcription on this computer, for a `local` connection. */
	localTranscription?: LocalTranscription;
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
 * times as `failures.answers` says. An answer fills its row through
 * `write`. A test may arm more after opening.
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
		async write(stem, from, to) {
			if (failures.answers === 0) return table.write(stem, from, to);
			failures.answers -= 1;
			return refusedResult(`${table.name}/${stem}.md`, 'write');
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
	others,
	epicenterEndpoint,
	localTranscription,
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
	const transformed: Transformed[] = [];
	const transcribed: Transcribed[] = [];
	const chosen = { ...TEST_CONNECTIONS, ...connections };
	const device = await testConnections({
		root: await realpath(
			await mkdtemp(join(tmpdir(), 'whispering-connections-')),
		),
		connections: chosen,
		others,
		epicenterEndpoint,
		local: localTranscription,
		async answer(request) {
			if (request.path === 'audio/transcriptions') {
				const { path: _, ...received } = request;
				transcribed.push(received);
				return transcribe !== undefined
					? transcribe(received)
					: Ok({ text: 'um so a steady tone' });
			}
			const { path: _, ...received } = request;
			transformed.push(received);
			return transform !== undefined
				? transform(received)
				: Ok({ text: `Transformed: ${received.input.trim()}` });
		},
	});
	for (const operation of ['transcription', 'text'] as const)
		if (chosen[operation])
			expectOk(
				await folder.kv.set(
					operation === 'transcription'
						? 'transcriptionConnection'
						: 'textConnection',
					TEST_CONNECTION_IDS[operation],
				),
			);
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
		folderId: WHISPERING_FOLDER_ID,
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
		localTranscription,
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
			await Promise.all([folder.close(), device.folder.close()]);
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
		/** The device's connections: its `so.epicenter`, keys, and secrets. */
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

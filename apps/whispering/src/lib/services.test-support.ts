/**
 * Services for tests: this browser's files, a fixture capture device that
 * keeps a generated tone as every recording, and stubbed endpoints. Nothing
 * here reaches a network, a microphone, or a provider.
 *
 * The files are the contract's client over a real directory
 * (`@epicenter/folder/node`), as the browser's OPFS holds them, at the same
 * paths.
 *
 * The endpoint stubs are plain functions, so a test decides each answer and
 * counts each request.
 */
import { mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@epicenter/definition/contract';
import { openDevice } from '@epicenter/folder/node';
import { audioDurationMs, RecorderError } from '@epicenter/recorder';
import { Err, Ok, unwrap } from 'wellcrafted/result';
import { extensionOf } from './audio-format.js';
import type { CaptureDevice, MicrophoneInputs } from './capture.js';
import {
	applyConnectionChange,
	type ConnectionsInfo,
	connectionInfo,
	connectionTargets,
	type Operation,
	type StoredConnection,
} from './connections.js';
import { type Whispering, whispering } from './contract.js';
import type { WhisperingServices } from './platform/types.js';
import { TranscriptionError } from './transcription.js';
import { TransformationError } from './transformation.js';

export type FixtureAudio = {
	readonly name: string;
	readonly bytes: Uint8Array;
};

/** Inputs with no microphone behind them: nothing is listed, and a test is refused. */
export const NO_INPUTS: MicrophoneInputs = {
	list: async () => Ok({ devices: [] }),
	meter: async () =>
		RecorderError.Unavailable({ reason: 'no microphone is behind this test' }),
	onChange: () => () => {},
};

/**
 * A capture device that keeps the same fixture bytes as every recording,
 * under the fixture's own extension, written into `device` when it stops,
 * over `NO_INPUTS`. `load` runs
 * at stop, so a missing or unreadable fixture fails that recording instead
 * of the session.
 */
export function createFixtureDevice({
	device,
	name,
	load,
}: {
	device: Client<Whispering>;
	name: string;
	load: () => Promise<FixtureAudio>;
}): CaptureDevice {
	const ext = extensionOf(name) || 'wav';
	return {
		inputs: NO_INPUTS,
		async start({ id }) {
			const startedAt = performance.now();
			let stopped = false;
			return Ok({
				startedAt,
				onEnded: () => () => {},
				async stop() {
					if (stopped) return RecorderError.Empty();
					stopped = true;
					let fixture: FixtureAudio;
					try {
						fixture = await load();
					} catch (cause) {
						return RecorderError.Failed({ cause });
					}
					if (fixture.bytes.byteLength === 0) return RecorderError.Empty();
					const written = await device.audio.create({
						id,
						ext,
						bytes: fixture.bytes,
					});
					if (written.error !== null)
						return RecorderError.Refused({ reason: written.error.message });
					return Ok({
						// The fixture's own length when it can be read, not the wait before Stop.
						durationMs:
							audioDurationMs(fixture.bytes, ext) ??
							Math.round(performance.now() - startedAt),
					});
				},
			});
		},
		recover: async () => Ok([]),
	};
}

/** A 440 Hz mono PCM WAV, one second long unless asked otherwise. */
export function toneWav({
	seconds = 1,
	sampleRate = 16000,
	frequency = 440,
} = {}): Uint8Array {
	const samples = Math.round(seconds * sampleRate);
	const bytes = new Uint8Array(44 + samples * 2);
	const view = new DataView(bytes.buffer);
	const text = (offset: number, value: string) => {
		for (let index = 0; index < value.length; index++)
			view.setUint8(offset + index, value.charCodeAt(index));
	};
	text(0, 'RIFF');
	view.setUint32(4, 36 + samples * 2, true);
	text(8, 'WAVE');
	text(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	text(36, 'data');
	view.setUint32(40, samples * 2, true);
	for (let index = 0; index < samples; index++)
		view.setInt16(
			44 + index * 2,
			Math.round(
				Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0x2000,
			),
			true,
		);
	return bytes;
}

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
		useAccount: async () => Err('Not in tests'),
		useCustom: async () => Ok(info()),
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

export type TestServicesOptions = {
	transcribe?: WhisperingServices['transcribe'];
	transform?: WhisperingServices['transform'];
	connections?: Partial<Record<Operation, StoredConnection>>;
};

/** This browser's files in a temporary directory, and services whose endpoints are stubs. */
export async function openTestServices({
	transcribe,
	transform,
	connections,
}: TestServicesOptions = {}) {
	const root = await mkdtemp(join(tmpdir(), 'whispering-'));
	const device = unwrap(
		await openDevice(whispering, { path: join(root, 'device') }),
	);
	const stored = testConnections({ connections });

	const transformed: TransformRequest[] = [];
	const transcribed: { request: TranscribeRequest; bytes: Uint8Array }[] = [];

	const services: WhisperingServices = {
		capture: createFixtureDevice({
			device,
			name: 'tone.wav',
			load: async () => ({ name: 'tone.wav', bytes: toneWav() }),
		}),
		// Each stub decides the connection as the browser does, at entry, and
		// reads the audio as it would; only a request that would go out is
		// counted as sent.
		async transcribe(request) {
			const refused = refusedConnection(
				stored.stored.transcription,
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
			const audio = await request.audio();
			if (audio.error !== null)
				return TranscriptionError.AudioUnreadable({ reason: audio.error });
			transcribed.push({ request, bytes: audio.data.bytes });
			if (transcribe !== undefined) return transcribe(request);
			return Ok({ text: 'um so a steady tone' });
		},
		async transform(request) {
			const refused = refusedConnection(
				stored.stored.text,
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
		connections: stored.member,
		preferences: {
			microphone: async () => undefined,
			setMicrophone: async () => undefined,
		},
	};

	return {
		root,
		/** This browser's files, as the contract's client. */
		device,
		services,
		/** Every transformation request the endpoint stub received, in order. */
		transformed,
		/** Every transcription request the endpoint stub received, with the audio it read. */
		transcribed,
		/** The device's stored connections, keys included. */
		connections: stored,
		/** Remove the directory. */
		async remove() {
			await rm(root, { recursive: true, force: true });
		},
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
		if (Date.now() > deadline)
			throw new Error(`Not true within ${timeoutMs} ms`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** The services the product's `createServices` answers in this test process. */
let provided: WhisperingServices | undefined;
let installed = false;
/** Give the product these doubles when it makes its services. */
export function provideServices(services: WhisperingServices) {
	provided = services;
	if (installed) return;
	installed = true;
	mock.module('#platform/services', () => ({
		createServices(): WhisperingServices {
			if (provided === undefined)
				throw new Error('No test services were provided');
			return provided;
		},
	}));
}

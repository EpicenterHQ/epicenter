/**
 * Services for tests: this browser's files and a stand-in repository, a
 * fixture capture device, and stubbed endpoints. Nothing here reaches a
 * network, a microphone, or a provider.
 *
 * Both sides are the contract's client over a real directory
 * (`@epicenter/folder/node`): the device as the browser's OPFS holds it, at
 * the same paths, with its outbox and cache; the repository stand-in is a
 * second directory, which is all the lists need of a repository (a
 * `Client<Whispering>`). What the server does is tested in
 * `@epicenter/folder`'s remote tests and the end-to-end suite.
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
import { Err, Ok } from 'wellcrafted/result';
import { createFixtureDevice, toneWav } from './capture.js';
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

/**
 * This browser's files and a stand-in repository in a temporary directory,
 * and services whose endpoints are stubs.
 */
export async function openTestServices({
	transcribe,
	transform,
	connections,
}: TestServicesOptions = {}) {
	const root = await mkdtemp(join(tmpdir(), 'whispering-'));
	const device = openDevice(whispering, { path: join(root, 'device') });
	const repository = openDevice(whispering, {
		path: join(root, 'repository'),
	});
	const stored = testConnections({ connections });

	const transformed: TransformRequest[] = [];
	const transcribed: { request: TranscribeRequest; bytes: Uint8Array }[] = [];

	const services: WhisperingServices = {
		capture: createFixtureDevice({
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
		/** The repository's stand-in, as the contract's client. */
		repository,
		services,
		/** Every transformation request the endpoint stub received, in order. */
		transformed,
		/** Every transcription request the endpoint stub received, with the audio it read. */
		transcribed,
		/** The device's stored connections, keys included. */
		connections: stored,
		/** Remove both directories. */
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

/** A client whose `name` collection answers some calls differently; the rest read through. */
export function replacing<TName extends keyof Whispering['collections']>(
	client: Client<Whispering>,
	name: TName,
	calls: Partial<Client<Whispering>[TName]>,
): Client<Whispering> {
	return { ...client, [name]: { ...client[name], ...calls } };
}

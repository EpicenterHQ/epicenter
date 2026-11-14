/**
 * Capabilities for tests: this browser's files, a fixture capture device that
 * keeps a generated tone as every recording, and one saved connection whose
 * `fetch` is a stub. Nothing here reaches a network, a microphone, or a
 * provider.
 *
 * The files are a place in memory (`memory()` from `@epicenter/folder/memory`)
 * holding the contract's files at the paths the repository holds them:
 * the app opens its folder there, the fixture device writes through a
 * folder of its own there, and a test writes or refuses as another program
 * through `memoryFiles`.
 *
 * The endpoint is a connection saved in this computer's settings (memory
 * under the `test` condition), its requests answered by a plain function
 * standing where `fetch` would be (ADR-0757), so a test decides each answer
 * and counts each request while the request itself is built and read as in
 * the app.
 */
import {
	customEndpoints,
	hosted,
	type LiveAccount,
	modelChoices,
	openAi,
} from '@epicenter/ai';
import { openFolder } from '@epicenter/folder';
import type { Folder } from '@epicenter/folder/core';
import { memory, memoryFiles } from '@epicenter/folder/memory';
import { settings } from '@epicenter/local';
import { outside as computer } from '@epicenter/local/memory';
import { audioDurationMs, RecorderError } from '@epicenter/recorder';
import { Ok, type Result } from 'wellcrafted/result';
import { extensionOf } from './audio-format.js';
import type { CaptureDevice } from './capture.js';
import { type Whispering, whispering } from './contract.js';
import type { WhisperingCapabilities } from './whispering.svelte.js';

export type FixtureAudio = {
	readonly name: string;
	readonly bytes: Uint8Array;
};

/** Inputs with no microphone behind them: nothing is listed, and a test is refused. */
export const NO_INPUTS: CaptureDevice['inputs'] = {
	listInputs: async () => Ok({ inputs: [] }),
	openMeter: async () =>
		RecorderError.Unavailable({ reason: 'no microphone is behind this test' }),
};

/**
 * A capture device that keeps the same fixture bytes as every recording,
 * under the fixture's own extension, written into `audio` when it stops,
 * over `NO_INPUTS`. `load` runs
 * at stop, so a missing or unreadable fixture fails that recording instead
 * of the session.
 */
export function createFixtureDevice({
	audio,
	name,
	load,
}: {
	/** Whispering's audio files (`folder.audio`), as the microphone device takes them. */
	audio: Folder<Whispering>['audio'];
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
					// The audio lands before Stop answers, as the recorder's does.
					await audio.set({ id, ext }, fixture.bytes);
					return Ok({
						// The fixture's own length when it can be read, not the wait before Stop.
						durationMs:
							audioDurationMs(fixture.bytes, ext) ??
							Math.round(performance.now() - startedAt),
					});
				},
			});
		},
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

/** What the stub endpoint received for one transcription. */
export type TranscribedRequest = {
	readonly model: string;
	readonly filename: string;
	readonly bytes: Uint8Array;
};

/** What the stub endpoint received for one transformation. */
export type TransformedRequest = {
	readonly model: string;
	readonly prompt: string;
	readonly input: string;
};

/** The base URL the stub endpoint answers at. */
export const TEST_BASE_URL = 'http://127.0.0.1:18080/v1';

/** The models a test device has chosen unless a test says otherwise. */
export const TEST_MODELS = {
	transcription: 'verification-model',
	text: 'connection-model',
} as const;

/** An answer as a stub gives it: the text, or why it failed. */
type StubAnswer = Result<{ text: string }, { message: string }>;

export type TestServicesOptions = {
	/** How the endpoint answers a transcription; by default a fixed transcript. */
	transcribe?: (request: TranscribedRequest) => Promise<StubAnswer>;
	/** How the endpoint answers a transformation; by default the input, marked. */
	transform?: (request: TransformedRequest) => Promise<StubAnswer>;
};

/** A chat completion streamed as server-sent events, as an OpenAI endpoint sends one. */
function streamed(text: string): Response {
	const events = [
		{ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
	]
		.map((event) => `data: ${JSON.stringify(event)}\n\n`)
		.join('');
	return new Response(`${events}data: [DONE]\n\n`, {
		headers: { 'content-type': 'text/event-stream' },
	});
}

/** A refusal in the OpenAI error shape. */
const refused = (message: string) =>
	Response.json({ error: { message } }, { status: 500 });

/** No one signed in, as a test's account stays. */
export const SIGNED_OUT: LiveAccount = {
	baseURL: 'https://api.epicenter.test',
	need() {},
	state: () => ({ status: 'signed-out' }),
	subscribe: () => () => {},
};

/** Memory standing in for this site's storage, which tells every opener of it of each write, as a page's other tabs hear. */
/** The page's own `fetch`, and the stub that answers the test endpoint in its place. */
const pageFetch = globalThis.fetch;
let answering:
	| ((url: string, init?: RequestInit) => Promise<Response>)
	| undefined;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input instanceof Request ? input.url : input);
	return answering !== undefined && url.startsWith(TEST_BASE_URL)
		? answering(url, init)
		: pageFetch(input, init);
}) as typeof fetch;

/** The capabilities Whispering is made over, but its folder: the test makes that over its directory. */
export type TestCapabilities = Omit<WhisperingCapabilities, 'folder'>;

/**
 * This browser's files in a new place in memory, and capabilities whose one
 * endpoint is a saved connection answered by a stub `fetch`, chosen for
 * transcription and for text. Nothing reaches a network.
 */
export async function openTestServices({
	transcribe,
	transform,
}: TestServicesOptions = {}) {
	const place = memory();
	// The capture device's own folder over the same files, as the app's is.
	const files = openFolder(whispering, place);

	const transformed: TransformedRequest[] = [];
	const transcribed: TranscribedRequest[] = [];

	/** The stub endpoint: every request a saved connection sends arrives here. */
	async function fetch(input: string, init?: RequestInit): Promise<Response> {
		const request = new Request(input, init);
		const path = request.url.slice(`${TEST_BASE_URL}/`.length);
		if (path === 'audio/transcriptions') {
			const form = await request.formData();
			const file = form.get('file') as File;
			const received = {
				model: String(form.get('model')),
				filename: file.name,
				bytes: new Uint8Array(await file.arrayBuffer()),
			};
			transcribed.push(received);
			const answer = transcribe
				? await transcribe(received)
				: Ok({ text: 'um so a steady tone' });
			return answer.error !== null
				? refused(answer.error.message)
				: Response.json({ text: answer.data.text });
		}
		if (path === 'chat/completions') {
			const body = (await request.json()) as {
				model: string;
				messages: { content: string }[];
			};
			const received = {
				model: body.model,
				prompt: body.messages[0]!.content,
				input: body.messages[1]!.content,
			};
			transformed.push(received);
			const answer = transform
				? await transform(received)
				: Ok({ text: `Transformed: ${received.input.trim()}` });
			return answer.error !== null
				? refused(answer.error.message)
				: streamed(answer.data.text);
		}
		return new Response('Not found', { status: 404 });
	}

	// This computer's settings, empty for each test: one saved connection,
	// answered by the stub, chosen for both jobs.
	answering = fetch;
	for (const name of ['connections.md', 'connection-keys.json', 'models.md'])
		computer.write(name, null);
	const connections = customEndpoints();
	await settings.file('connections.md').connected();
	const connectionId = await connections.add({
		name: 'Test endpoint',
		baseUrl: TEST_BASE_URL,
		models: [TEST_MODELS.transcription, TEST_MODELS.text],
	});
	const choices = modelChoices<'transcribe' | 'chat'>();
	await choices.set('transcribe', {
		endpoint: connectionId,
		model: TEST_MODELS.transcription,
	});
	await choices.set('chat', {
		endpoint: connectionId,
		model: TEST_MODELS.text,
	});

	const services: TestCapabilities = {
		capture: createFixtureDevice({
			audio: files.audio,
			name: 'tone.wav',
			load: async () => ({ name: 'tone.wav', bytes: toneWav() }),
		}),
		ai: openAi([hosted(SIGNED_OUT), connections]),
		choices,
		preferences: {
			microphone: () => undefined,
			setMicrophone: async () => undefined,
		},
	};

	return {
		/** Where this browser's files are: the app's folder opens here. */
		place,
		/** This browser's files, as another page of it opens them. */
		files,
		/** This browser's files as another program writes, reads, and refuses them. */
		outside: memoryFiles(place),
		services,
		/** Every transformation request the endpoint stub received, in order. */
		transformed,
		/** Every transcription request the endpoint stub received, with the audio it carried. */
		transcribed,
		/** This computer's saved connections, and the id of the one the stub answers. */
		connections,
		connectionId,
		/** This computer's model choices. */
		choices,
		/** Close the files' folder. */
		close() {
			files[Symbol.dispose]();
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

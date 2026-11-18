/**
 * Capabilities for tests: Whispering's files in memory, a fixture capture
 * device that keeps a generated tone as every recording, and one saved
 * connection whose `fetch` is a stub. Nothing here reaches a network, a
 * microphone, or a provider.
 *
 * The files are `memoryFiles()` behind `testFiles`, which a test can make
 * refuse writes or reads under a directory, as a full disk or a private
 * window does, and which lists every path held. The app's folder opens
 * over them, and a test writes or reads as another program through
 * `outside`.
 *
 * The endpoint is a connection saved in `settings.md`, its key kept in
 * memory, its requests answered by a plain function standing where `fetch`
 * would be (ADR-0757), so a test decides each answer and counts each
 * request while the request itself is built and read as in the app.
 */
import { customEndpoints, openAi } from '@epicenter/ai';
import { audioDurationMs, RecorderError } from '@epicenter/recorder';
import { QueryObserver } from '@tanstack/query-core';
import { runQuery } from 'wellcrafted/query';
import { Ok, type Result } from 'wellcrafted/result';
import { extensionOf } from './audio-format.js';
import type { CaptureDevice } from './capture.js';
import { encode, type Files, failed } from './files/files.js';
import { memoryFiles } from './files/memory.js';
import { openFolder } from './folder.js';
import { createFolderQuery } from './folder-query.js';
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
	files,
	name,
	load,
}: {
	/** Whispering's files, which the audio is written into at `recordings/<id>.<ext>`. */
	files: Files;
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
					const written = await files.write(
						`recordings/${id}.${ext}`,
						fixture.bytes,
					);
					if (written.error !== null)
						return RecorderError.Failed({ cause: written.error });
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

/**
 * Whispering's folder and the page's query client over `files`, with the
 * folder query observed and read once, as the app's layout observes it
 * before the pages render. `close` stops observing and empties the cache.
 */
export async function openPage(files: Files) {
	const folder = openFolder(files);
	const query = createFolderQuery(folder);
	const observer = new QueryObserver(
		query.queryClient,
		query.folderQueries.read(),
	);
	const unobserve = observer.subscribe(() => {});
	const first = await runQuery(query.queryClient, query.folderQueries.read());
	return {
		folder,
		query,
		/** What the first read answered. */
		first,
		close() {
			unobserve();
			query.queryClient.clear();
		},
	};
}

/** The capabilities Whispering is made over, but its folder query: the test opens that over its files. */
export type TestCapabilities = Omit<WhisperingCapabilities, 'query'>;

/** A refusal a test set: every write, or read, under `under` fails with `reason`. */
type Refusal = { reason: string; under: string; reads: boolean };

/**
 * Whispering's files in memory, as the app and another program reach them:
 * `files` is what the app opens, and refuses what a test told it to;
 * `outside` writes and reads without refusal and lists every path held.
 */
export function testFiles() {
	const inner = memoryFiles();
	const held = new Set<string>();
	const refusals = new Set<Refusal>();
	const refusing = (path: string, reads: boolean) =>
		[...refusals].find(
			(refusal) =>
				refusal.reads === reads &&
				(refusal.under === '' || path.startsWith(`${refusal.under}/`)),
		);
	const refused = (
		operation: 'read' | 'write' | 'list' | 'remove',
		path: string,
		reason: string,
	) => failed(`Could not ${operation} ${path}: ${reason}`);

	const files: Files = {
		async read(path) {
			const refusal = refusing(path, true);
			if (refusal) return refused('read', path, refusal.reason);
			return inner.read(path);
		},
		async write(path, bytes) {
			const refusal = refusing(path, false);
			if (refusal) return refused('write', path, refusal.reason);
			const written = await inner.write(path, bytes);
			if (written.error === null) held.add(path);
			return written;
		},
		async readMany(paths) {
			for (const path of paths) {
				const refusal = refusing(path, true);
				if (refusal) return refused('read', path, refusal.reason);
			}
			return inner.readMany(paths);
		},
		async list(dir) {
			const refusal = refusing(`${dir}/`, true);
			if (refusal) return refused('list', dir, refusal.reason);
			return inner.list(dir);
		},
		async remove(path) {
			const refusal = refusing(path, false);
			if (refusal) return refused('remove', path, refusal.reason);
			const removed = await inner.remove(path);
			if (removed.error === null) held.delete(path);
			return removed;
		},
	};

	/** Set `refusal` until the returned function undoes it. */
	function refuse(refusal: Refusal) {
		refusals.add(refusal);
		return () => void refusals.delete(refusal);
	}

	return {
		files,
		outside: {
			/** Write `content` at `path`, as another program does. */
			async write(path: string, content: string | Uint8Array) {
				const bytes = typeof content === 'string' ? encode(content) : content;
				const written = await inner.write(path, bytes);
				if (written.error !== null) throw written.error;
				held.add(path);
			},
			/** The text at `path`, or null. */
			async read(path: string) {
				const read = await inner.read(path);
				if (read.error !== null) throw read.error;
				return read.data === null ? null : new TextDecoder().decode(read.data);
			},
			/** Every path held under `dir`, sorted. */
			paths(dir = '') {
				return [...held]
					.filter((path) => dir === '' || path.startsWith(`${dir}/`))
					.sort();
			},
			/** Refuse every write and removal under `under` (everywhere by default) until undone. */
			refuse: (reason: string, { under = '' }: { under?: string } = {}) =>
				refuse({ reason, under, reads: false }),
			/** Refuse every read and listing under `under` (everywhere by default) until undone. */
			refuseReads: (reason: string, { under = '' }: { under?: string } = {}) =>
				refuse({ reason, under, reads: true }),
		},
	};
}

/**
 * Whispering's files in memory, and capabilities whose one endpoint is a
 * connection saved in `settings.md` and answered by a stub `fetch`, chosen
 * for transcription and for text. Nothing reaches a network.
 */
export async function openTestServices({
	transcribe,
	transform,
}: TestServicesOptions = {}) {
	const { files, outside } = testFiles();
	// The settings as the app reads them: its folder's `settings.md`.
	const page = await openPage(files);
	const { settings } = page.query;

	const transformed: TransformedRequest[] = [];
	const transcribed: TranscribedRequest[] = [];

	/** The stub endpoint: every request a saved connection sends arrives here. */
	async function fetch(input: string, init?: RequestInit): Promise<Response> {
		const request = new Request(input, init);
		if (!request.url.startsWith(`${TEST_BASE_URL}/`))
			return new Response('Not found', { status: 404 });
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

	// One saved connection, answered by the stub, chosen for both jobs.
	const keys = new Map<string, string>();
	const connections = customEndpoints({
		store: settings.connections,
		keys: {
			get: async (id) => keys.get(id) ?? null,
			set: async (id, key) => {
				if (key === null) keys.delete(id);
				else keys.set(id, key);
			},
		},
		fetch,
	});
	const connectionId = await connections.add({
		name: 'Test endpoint',
		baseUrl: TEST_BASE_URL,
		models: [TEST_MODELS.transcription, TEST_MODELS.text],
	});
	const { choices } = settings;
	for (const [job, model] of [
		['transcribe', TEST_MODELS.transcription],
		['chat', TEST_MODELS.text],
	] as const) {
		const chosen = await choices.set(job, { endpoint: connectionId, model });
		if (chosen.error !== null) throw chosen.error;
	}

	const services: TestCapabilities = {
		capture: createFixtureDevice({
			files,
			name: 'tone.wav',
			load: async () => ({ name: 'tone.wav', bytes: toneWav() }),
		}),
		ai: openAi([connections]),
		choices,
		preferences: {
			microphone: () => undefined,
			setMicrophone: async () => undefined,
		},
	};

	return {
		/** Whispering's files, as the app opens them. */
		files,
		/** The same files as another program writes, reads, and refuses them. */
		outside,
		services,
		/** Every transformation request the endpoint stub received, in order. */
		transformed,
		/** Every transcription request the endpoint stub received, with the audio it carried. */
		transcribed,
		/** The saved connections, and the id of the one the stub answers. */
		connections,
		connectionId,
		/** The model choices, in `settings.md`. */
		choices,
		/** Stop following `settings.md`. */
		close: page.close,
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

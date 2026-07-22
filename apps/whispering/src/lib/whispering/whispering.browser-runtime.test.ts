import { expect, mock, test } from 'bun:test';
import type {
	RecordSyncSession,
	RecordSyncStatus,
} from '@epicenter/data/record';
import type { WhisperingApp } from './app.js';
import { openWhisperingBrowserEpicenter } from './whispering.browser-runtime.js';

mock.module('$lib/operations/analytics', () => ({
	logAnalyticsEvent: async () => undefined,
}));
mock.module('$lib/operations/transcription-history', () => ({
	recordTranscriptionOutcome: async () => {
		throw new Error('Unexpected transcription history write');
	},
	saveRecordingHistory: async () => {
		throw new Error('Unexpected transcription history write');
	},
}));
mock.module('$lib/report', () => ({
	log: {
		info: () => undefined,
		warn: () => undefined,
	},
	report: { info: () => undefined },
}));
mock.module('$lib/services/transcription/cloud/deepgram', () => ({
	DeepgramTranscriptionServiceLive: {},
}));
mock.module('$lib/services/transcription/cloud/elevenlabs', () => ({
	ElevenLabsTranscriptionServiceLive: {},
}));
mock.module('$lib/services/transcription/cloud/mistral', () => ({
	MistralTranscriptionServiceLive: {},
}));
mock.module('$lib/services/transcription/providers', () => ({
	isOnDeviceProviderId: () => false,
	PROVIDERS: { epicenter: { model: 'whisper-1' } },
}));
mock.module('$lib/state/device-config.svelte', () => ({
	deviceConfig: { get: () => undefined },
}));
mock.module('$lib/state/secrets.svelte', () => ({
	secrets: { get: () => ({ status: 'missing' }) },
}));
mock.module('#platform/auth', () => ({
	auth: {
		deployment: { baseURL: 'https://fallback.invalid' },
		fetch: () => Promise.reject(new Error('Unexpected fallback fetch')),
	},
}));
mock.module('#platform/http', () => ({ customFetch: undefined }));
mock.module('#platform/tauri', () => ({ tauri: undefined }));

const { transcribeAudio } = await import('../operations/transcribe.js');

type Attachment =
	| { kind: 'unattached'; requiresChoice: boolean }
	| {
			kind: 'attached';
			attachment: { deploymentId: string; principalId: string };
	  };

type TestAuthState =
	| { status: 'signed-out' }
	| { status: 'signed-in'; principalId: string };

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => (resolve = done));
	return { promise, resolve };
}

function createAuth(
	initiallySignedIn: boolean,
	beforeFetchResponse: Promise<void> = Promise.resolve(),
) {
	let state: TestAuthState = initiallySignedIn
		? { status: 'signed-in', principalId: 'principal-one' }
		: { status: 'signed-out' };
	const listeners = new Set<(state: TestAuthState) => void>();
	const requests: Request[] = [];
	return {
		requests,
		get state() {
			return state;
		},
		deployment: { kind: 'hosted' as const, baseURL: 'https://api.example.com' },
		onStateChange(listener: (next: TestAuthState) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async fetch(request: Request | string | URL, init?: RequestInit) {
			requests.push(new Request(request, init));
			await (init?.signal === undefined
				? beforeFetchResponse
				: Promise.race([
						beforeFetchResponse,
						new Promise<never>((_resolve, reject) => {
							if (init.signal?.aborted) {
								reject(init.signal.reason);
								return;
							}
							init.signal?.addEventListener(
								'abort',
								() => reject(init.signal?.reason),
								{ once: true },
							);
						}),
					]));
			return Response.json({
				authorityLifetime: 'lifetime-one',
				facts: [],
				hasMore: false,
			});
		},
		signInAs(principalId: string) {
			state = { status: 'signed-in', principalId };
			for (const listener of listeners) listener(state);
		},
	};
}

function createEpicenter(initialAttachment: Attachment) {
	let attachment = initialAttachment;
	let syncStatus: RecordSyncStatus = {
		state: initialAttachment.kind === 'attached' ? 'idle' : 'local',
		work: {
			scalar: { pending: 0, sealed: 0, parked: 0 },
			document: { pending: 0, parked: 0 },
			blob: { pending: 0, parked: 0 },
		},
		...(initialAttachment.kind === 'attached'
			? { authorityLifetime: 'lifetime-one' }
			: {}),
	};
	const attachmentListeners = new Set<(next: Attachment) => void>();
	const statusListeners = new Set<(next: RecordSyncStatus) => void>();
	const sessions: RecordSyncSession<Blob>[] = [];
	let disposals = 0;
	return {
		sessions,
		get disposals() {
			return disposals;
		},
		value: {
			bind() {
				throw new Error('Lens binding is not expected');
			},
			get attachment() {
				return attachment;
			},
			get syncStatus() {
				return syncStatus;
			},
			subscribeAttachment(listener: (next: Attachment) => void) {
				attachmentListeners.add(listener);
				return () => attachmentListeners.delete(listener);
			},
			subscribeSyncStatus(listener: (next: RecordSyncStatus) => void) {
				statusListeners.add(listener);
				return () => statusListeners.delete(listener);
			},
			async attachSync(session: RecordSyncSession<Blob>) {
				sessions.push(session);
				attachment = { kind: 'attached', attachment: session.attachment };
				for (const listener of attachmentListeners) listener(attachment);
				const facts = await session.transport.readFacts({ afterSequence: 0 });
				syncStatus = {
					...syncStatus,
					state: 'idle',
					authorityLifetime: facts.authorityLifetime,
				};
				for (const listener of statusListeners) listener(syncStatus);
			},
			parkedWork: async () => ({ scalar: [], document: [], blob: [] }),
			inspectRecord: async () => ({ fields: [], blobs: [], documents: [] }),
			async [Symbol.asyncDispose]() {
				disposals += 1;
			},
		},
	};
}

test('signed-in empty data attaches through auth-owned fetch', async () => {
	const auth = createAuth(true);
	const epicenter = createEpicenter({
		kind: 'unattached',
		requiresChoice: false,
	});
	const runtime = await openWhisperingBrowserEpicenter({
		auth: auth as never,
		reportBackgroundError: (cause) => {
			throw cause;
		},
		openEpicenter: async () => epicenter.value as never,
	});
	try {
		expect(epicenter.sessions).toHaveLength(1);
		expect(epicenter.sessions[0]?.firstAttachmentChoice).toBeUndefined();
		expect(auth.requests).toHaveLength(1);
		expect(auth.requests[0]?.headers.has('authorization')).toBe(false);
	} finally {
		await runtime[Symbol.asyncDispose]();
	}
	expect(epicenter.disposals).toBe(1);
});

test('sign-in preserves nonempty local data until an explicit choice', async () => {
	const auth = createAuth(false);
	const epicenter = createEpicenter({
		kind: 'unattached',
		requiresChoice: true,
	});
	const runtime = await openWhisperingBrowserEpicenter({
		auth: auth as never,
		reportBackgroundError: (cause) => {
			throw cause;
		},
		openEpicenter: async () => epicenter.value as never,
	});
	try {
		auth.signInAs('principal-one');
		await Promise.resolve();
		await Promise.resolve();
		expect(epicenter.sessions).toHaveLength(0);

		await runtime.chooseFirstAttachment('bring');
		expect(epicenter.sessions).toHaveLength(1);
		expect(epicenter.sessions[0]?.firstAttachmentChoice).toBe('bring');
	} finally {
		await runtime[Symbol.asyncDispose]();
	}
});

test('an identity change during first attachment cannot install the new principal', async () => {
	const releaseFetch = deferred();
	const auth = createAuth(true, releaseFetch.promise);
	const epicenter = createEpicenter({
		kind: 'unattached',
		requiresChoice: false,
	});
	const backgroundErrors: unknown[] = [];
	const opening = openWhisperingBrowserEpicenter({
		auth: auth as never,
		reportBackgroundError: (cause) => backgroundErrors.push(cause),
		openEpicenter: async () => epicenter.value as never,
	});
	while (auth.requests.length === 0) await Promise.resolve();
	auth.signInAs('principal-two');
	releaseFetch.resolve();
	const runtime = await opening;
	try {
		expect(epicenter.sessions).toHaveLength(1);
		expect(epicenter.sessions[0]?.attachment.principalId).toBe('principal-one');
		expect(runtime.identity).toEqual({
			kind: 'principal-mismatch',
			attachedPrincipalId: 'principal-one',
			signedInPrincipalId: 'principal-two',
		});
		expect(epicenter.value.syncStatus.authorityLifetime).toBeUndefined();
		expect(backgroundErrors).not.toHaveLength(0);
	} finally {
		await runtime[Symbol.asyncDispose]();
	}
});

test('disposal aborts an in-flight attachment before releasing the replica', async () => {
	const never = new Promise<void>(() => undefined);
	const auth = createAuth(false, never);
	const epicenter = createEpicenter({
		kind: 'unattached',
		requiresChoice: false,
	});
	const runtime = await openWhisperingBrowserEpicenter({
		auth: auth as never,
		reportBackgroundError: () => undefined,
		openEpicenter: async () => epicenter.value as never,
	});
	auth.signInAs('principal-one');
	while (auth.requests.length === 0) await Promise.resolve();
	await runtime[Symbol.asyncDispose]();
	expect(epicenter.disposals).toBe(1);
});

test('an attached replica reports a different signed-in principal without syncing', async () => {
	const auth = createAuth(true);
	auth.signInAs('principal-two');
	const epicenter = createEpicenter({
		kind: 'attached',
		attachment: {
			deploymentId: 'https://api.example.com/',
			principalId: 'principal-one',
		},
	});
	const runtime = await openWhisperingBrowserEpicenter({
		auth: auth as never,
		reportBackgroundError: () => undefined,
		openEpicenter: async () => epicenter.value as never,
	});
	try {
		expect(runtime.identity).toEqual({
			kind: 'principal-mismatch',
			attachedPrincipalId: 'principal-one',
			signedInPrincipalId: 'principal-two',
		});
		expect(epicenter.sessions).toHaveLength(0);
		expect(auth.requests).toHaveLength(0);
	} finally {
		await runtime[Symbol.asyncDispose]();
	}
});

test('an account switch during audio read cannot send with the new principal', async () => {
	const auth = createAuth(true);
	const epicenter = createEpicenter({
		kind: 'unattached',
		requiresChoice: false,
	});
	const runtime = await openWhisperingBrowserEpicenter({
		auth: auth as never,
		reportBackgroundError: () => undefined,
		openEpicenter: async () => epicenter.value as never,
	});
	const readStarted = deferred();
	const releaseRead = deferred();
	try {
		auth.requests.length = 0;
		const app = {
			settings: {
				get(key: string) {
					switch (key) {
						case 'analytics.enabled':
							return false;
						case 'transcription.service':
							return 'epicenter';
						case 'transcription.language':
							return 'auto';
						case 'transcription.prompt':
							return '';
						case 'dictionary':
							return [];
						default:
							throw new Error(`Unexpected setting: ${key}`);
					}
				},
			},
			recordings: {
				async readAudio() {
					readStarted.resolve();
					await releaseRead.promise;
					return new Blob(['principal-one audio'], { type: 'audio/wav' });
				},
			},
			beginAuthenticatedRequest: runtime.beginAuthenticatedRequest,
		} as unknown as WhisperingApp;

		const transcription = transcribeAudio(app, 'recording-one' as never);
		await readStarted.promise;
		auth.signInAs('principal-two');
		releaseRead.resolve();

		const result = await transcription;
		expect(result.error?.name).toBe('TransportFailed');
		expect(auth.requests).toHaveLength(0);
	} finally {
		releaseRead.resolve();
		await runtime[Symbol.asyncDispose]();
	}
});

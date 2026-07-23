import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBunRecordEpicenter } from '@epicenter/data/bun';
import type {
	RecordSyncSession,
	RecordSyncStatus,
} from '@epicenter/data/record';
import { defineLens, defineTable } from '@epicenter/data/record';
import { field } from '@epicenter/field';

import { openHoneycrispBrowserEpicenter } from './browser.js';

type Attachment =
	| { kind: 'unattached'; requiresChoice: boolean }
	| {
			kind: 'attached';
			attachment: { deploymentId: string; principalId: string };
	  };

type TestAuthState =
	| { status: 'signed-out' }
	| { status: 'signed-in'; principalId: string };

class FakeSocket {
	readyState = 0;
	protocol = '';
	binaryType = '';
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose:
		| ((event: { code: number; reason: string; wasClean: boolean }) => void)
		| null = null;

	send(): void {}

	close(): void {
		this.readyState = 3;
	}
}

const documentLens = defineLens({
	namespace: 'so.epicenter.honeycrisptest',
	title: 'Honeycrisp browser test',
	description: 'Provides a real record-owned document handle.',
	collections: {
		notes: defineTable({
			title: 'Notes',
			fields: { title: field.string() },
			optional: [],
		}),
	},
});

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
	const socketRequests: {
		url: string | URL;
		protocols: string[];
		socket: FakeSocket;
	}[] = [];
	return {
		requests,
		socketRequests,
		get state() {
			return state;
		},
		deployment: { kind: 'hosted' as const, baseURL: 'https://api.example.com' },
		onStateChange(listener: (next: TestAuthState) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async fetch(request: Request | string | URL, init?: RequestInit) {
			const opened = new Request(request, init);
			requests.push(opened);
			await beforeFetchResponse;
			return Response.json({
				authorityLifetime: 'lifetime-one',
				facts: [],
				hasMore: false,
			});
		},
		async openWebSocket(
			url: string | URL,
			protocols: string[] = [],
		): Promise<WebSocket> {
			const socket = new FakeSocket();
			socketRequests.push({ url, protocols, socket });
			return socket as unknown as WebSocket;
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
			document: { owed: 0, parked: 0 },
			blob: { owed: 0, parked: 0 },
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
	const runtime = await openHoneycrispBrowserEpicenter({
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
	const runtime = await openHoneycrispBrowserEpicenter({
		auth: auth as never,
		reportBackgroundError: (cause) => {
			throw cause;
		},
		openEpicenter: async () => epicenter.value as never,
	});
	try {
		expect(epicenter.sessions).toHaveLength(0);
		auth.signInAs('principal-one');
		await Promise.resolve();
		await Promise.resolve();
		expect(epicenter.sessions).toHaveLength(0);

		await runtime.chooseFirstAttachment('bring');
		expect(epicenter.sessions).toHaveLength(1);
		expect(epicenter.sessions[0]?.firstAttachmentChoice).toBe('bring');
		expect(epicenter.sessions[0]?.attachment).toEqual({
			deploymentId: 'https://api.example.com/',
			principalId: 'principal-one',
		});
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
	const opening = openHoneycrispBrowserEpicenter({
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
	const runtime = await openHoneycrispBrowserEpicenter({
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

test('an open document cannot reconnect with a different principal', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'honeycrisp-identity-'));
	const documentOwner = await openBunRecordEpicenter({ directory });
	const auth = createAuth(true);
	const epicenter = createEpicenter({
		kind: 'attached',
		attachment: {
			deploymentId: 'https://api.example.com/',
			principalId: 'principal-one',
		},
	});
	const runtime = await openHoneycrispBrowserEpicenter({
		auth: auth as never,
		reportBackgroundError: () => undefined,
		openEpicenter: async () => epicenter.value as never,
	});
	const notes = documentOwner.bind({ test: documentLens }).test.notes;
	const row = await notes.create({ title: 'Identity fenced' });
	const document = await notes.openDocument(row.id);
	const connection = runtime.connectDocument(document);
	try {
		while (auth.socketRequests.length === 0) await Promise.resolve();
		expect(auth.socketRequests[0]?.protocols).toHaveLength(1);
		expect(auth.socketRequests[0]?.protocols[0]).not.toStartWith('bearer.');

		auth.signInAs('principal-two');
		await Promise.resolve();
		await Promise.resolve();
		expect(auth.socketRequests).toHaveLength(1);
		expect(auth.socketRequests[0]?.socket.readyState).toBe(3);
		expect(connection.status).toBe('authentication-required');
	} finally {
		connection.dispose();
		await document[Symbol.asyncDispose]();
		await runtime[Symbol.asyncDispose]();
		await documentOwner[Symbol.asyncDispose]();
		await rm(directory, { recursive: true });
	}
});

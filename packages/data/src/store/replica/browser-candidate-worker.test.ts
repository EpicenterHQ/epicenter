/**
 * Browser Replica Candidate Liveness Tests
 *
 * Verifies that the dedicated-worker candidate protocol repairs lossy
 * BroadcastChannel coordination without weakening owner-session fencing.
 *
 * Key behaviors:
 * - Lost discovery, read requests, read replies, and invalidations are retried
 * - Pending reads move to a replacement owner session
 * - Pending mutations fail with owner-lost and are never replayed after handoff
 */
import { expect, test } from 'bun:test';

import { BLOB_PUBLICATION_VERSION } from '../../blob-v1/index.js';
import { DOCUMENT_PUBLICATION_VERSION } from '../../document-v1/index.js';
import type { RecordAddress } from '../../protocol/v1/index.js';
import { makeLimits } from '../../protocol/v1/kernel.test-support.js';
import type {
	BrowserReplicaCandidateInbound,
	BrowserReplicaCandidateOutbound,
	BrowserReplicaCandidateStart,
	BrowserReplicaCoordinationMessage,
} from './browser-candidate-protocol.js';
import {
	type BrowserReplicaCandidateWorkerDependencies,
	type BrowserReplicaCandidateWorkerScope,
	startBrowserReplicaCandidateWorker,
} from './browser-candidate-worker.js';
import type {
	BrowserReplicaOwnerResult,
	BrowserReplicaStoreOperation,
} from './browser-owner-protocol.js';

const address: RecordAddress = {
	namespace: 'so.epicenter.test',
	collection: 'records',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};

const start: BrowserReplicaCandidateStart = {
	type: 'start',
	limits: makeLimits(),
	initialize: { replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr' },
	coordinationId: 'candidate-liveness-test',
};

const countedMutationKinds = new Set<BrowserReplicaStoreOperation['kind']>([
	'local-write',
	'append-local-document',
	'install-accepted-document',
	'document-publication',
	'settle-document-publication',
	'capture-blob',
	'settle-blob-publication',
	'sweep-blob-debris',
]);

const w3MutationOperations = [
	{
		kind: 'append-local-document',
		address,
		update: new Uint8Array([1]),
	},
	{
		kind: 'install-accepted-document',
		address,
		update: new Uint8Array([2]),
	},
	{
		kind: 'document-publication',
		address,
	},
	{
		kind: 'settle-document-publication',
		address,
		proof: {
			authorityLifetime: 'authority-lifetime',
			address,
			protocolVersion: DOCUMENT_PUBLICATION_VERSION,
			digest: 'a'.repeat(64),
		},
		captured: { revision: 1, digest: 'a'.repeat(64) },
	},
	{ kind: 'capture-blob', address, bytes: new Blob(['immutable']) },
	{
		kind: 'settle-blob-publication',
		address,
		acceptance: {
			kind: 'accepted',
			receipt: {
				authorityLifetime: 'authority-lifetime',
				address,
				protocolVersion: BLOB_PUBLICATION_VERSION,
				digest: 'b'.repeat(64),
			},
		},
	},
	{ kind: 'sweep-blob-debris' },
] satisfies BrowserReplicaStoreOperation[];

type LossRule = {
	sender: string;
	type: BrowserReplicaCoordinationMessage['type'];
};

class FakeBroadcastHub {
	private readonly channels = new Map<string, Set<FakeBroadcastChannel>>();
	private readonly losses: LossRule[] = [];
	private readonly permanentLosses: LossRule[] = [];

	create(name: string, sender: string): FakeBroadcastChannel {
		const channel = new FakeBroadcastChannel(this, name, sender);
		const channels = this.channels.get(name) ?? new Set();
		channels.add(channel);
		this.channels.set(name, channels);
		return channel;
	}

	dropNext(sender: string, type: LossRule['type']): void {
		this.losses.push({ sender, type });
	}

	dropEvery(sender: string, type: LossRule['type']): void {
		this.permanentLosses.push({ sender, type });
	}

	post(
		source: FakeBroadcastChannel,
		name: string,
		message: BrowserReplicaCoordinationMessage,
	): void {
		if (
			this.permanentLosses.some(
				(loss) => loss.sender === source.sender && loss.type === message.type,
			)
		)
			return;
		const lossIndex = this.losses.findIndex(
			(loss) => loss.sender === source.sender && loss.type === message.type,
		);
		if (lossIndex !== -1) {
			this.losses.splice(lossIndex, 1);
			return;
		}
		for (const target of this.channels.get(name) ?? []) {
			if (target === source) continue;
			target.onmessage?.({ data: structuredClone(message) });
		}
	}

	remove(channel: FakeBroadcastChannel, name: string): void {
		this.channels.get(name)?.delete(channel);
	}
}

class FakeBroadcastChannel {
	onmessage: ((event: { data: unknown }) => void) | null = null;

	constructor(
		private readonly hub: FakeBroadcastHub,
		private readonly name: string,
		readonly sender: string,
	) {}

	postMessage(message: BrowserReplicaCoordinationMessage): void {
		this.hub.post(this, this.name, message);
	}

	close(): void {
		this.hub.remove(this, this.name);
	}
}

class ManualScheduler {
	private nextHandle = 0;
	private readonly callbacks = new Map<number, () => void>();

	schedule = (callback: () => void): number => {
		const handle = this.nextHandle++;
		this.callbacks.set(handle, callback);
		return handle;
	};

	cancel = (handle: unknown): void => {
		this.callbacks.delete(handle as number);
	};

	runNext(): void {
		const next = this.callbacks.entries().next().value;
		if (next === undefined) throw new Error('No retry callback was scheduled');
		const [handle, callback] = next;
		this.callbacks.delete(handle);
		callback();
	}
}

class FakeWorkerScope implements BrowserReplicaCandidateWorkerScope {
	readonly messages: BrowserReplicaCandidateOutbound[] = [];
	private listener:
		| ((event: { data: BrowserReplicaCandidateInbound }) => void)
		| undefined;
	isClosed = false;

	postMessage(message: BrowserReplicaCandidateOutbound): void {
		this.messages.push(structuredClone(message));
	}

	addEventListener(
		_type: 'message',
		listener: (event: { data: BrowserReplicaCandidateInbound }) => void,
	): void {
		this.listener = listener;
	}

	close(): void {
		this.isClosed = true;
	}

	send(message: BrowserReplicaCandidateInbound): void {
		if (this.listener === undefined) throw new Error('Worker was not started');
		this.listener({ data: message });
	}
}

function deferred<TValue>() {
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve(value: TValue): void {
			resolvePromise?.(value);
		},
	};
}

async function flush(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function setup(options?: {
	dropInitialDiscovery?: boolean;
	dropEveryDiscovery?: boolean;
}) {
	const hub = new FakeBroadcastHub();
	const ownerScheduler = new ManualScheduler();
	const followerScheduler = new ManualScheduler();
	const ownerScope = new FakeWorkerScope();
	const followerScope = new FakeWorkerScope();
	const followerOwnership = deferred<{
		execute(operation: BrowserReplicaStoreOperation): BrowserReplicaOwnerResult;
		dispose(): Promise<void>;
	}>();
	const values = new Map<string, string>();
	const executions = {
		ownerReads: 0,
		followerReads: 0,
		ownerMutations: 0,
		followerMutations: 0,
	};

	function createOwner(label: 'owner' | 'follower') {
		return {
			execute(
				operation: BrowserReplicaStoreOperation,
			): BrowserReplicaOwnerResult {
				if (operation.kind === 'record') {
					executions[`${label}Reads`] += 1;
					return values.get(operation.address.recordKey) ?? null;
				}
				if (countedMutationKinds.has(operation.kind)) {
					executions[`${label}Mutations`] += 1;
				}
				if (operation.kind === 'local-write') {
					if (operation.intent.op === 'replace') {
						values.set(
							operation.intent.address.recordKey,
							String(operation.intent.value),
						);
					}
				}
				return undefined;
			},
			async dispose(): Promise<void> {
				if (label === 'owner')
					followerOwnership.resolve(createOwner('follower'));
			},
		};
	}

	function dependencies(
		label: 'owner' | 'follower',
		scheduler: ManualScheduler,
	): BrowserReplicaCandidateWorkerDependencies {
		let nextUuid = 0;
		return {
			createChannel: (name) => hub.create(name, label),
			openOwner: () =>
				label === 'owner'
					? Promise.resolve(createOwner('owner'))
					: followerOwnership.promise,
			randomUuid: () => `${label}-${nextUuid++}`,
			schedule: scheduler.schedule,
			cancelSchedule: scheduler.cancel,
		};
	}

	startBrowserReplicaCandidateWorker(
		ownerScope,
		dependencies('owner', ownerScheduler),
	);
	ownerScope.send(start);
	await flush();
	if (options?.dropInitialDiscovery === true) {
		hub.dropNext('follower', 'discover');
	}
	if (options?.dropEveryDiscovery === true) {
		hub.dropEvery('follower', 'discover');
	}
	startBrowserReplicaCandidateWorker(
		followerScope,
		dependencies('follower', followerScheduler),
	);
	followerScope.send(start);
	await flush();

	return {
		hub,
		ownerScheduler,
		followerScheduler,
		ownerScope,
		followerScope,
		executions,
		values,
	};
}

function messagesOfType<TType extends BrowserReplicaCandidateOutbound['type']>(
	scope: FakeWorkerScope,
	type: TType,
): Extract<BrowserReplicaCandidateOutbound, { type: TType }>[] {
	return scope.messages.filter(
		(
			message,
		): message is Extract<BrowserReplicaCandidateOutbound, { type: TType }> =>
			message.type === type,
	);
}

test('lost discovery is retried until the existing owner is found', async () => {
	const { followerScheduler, followerScope } = await setup({
		dropInitialDiscovery: true,
	});

	expect(messagesOfType(followerScope, 'status').at(-1)?.role).toBe('waiting');
	followerScheduler.runNext();
	await flush();

	expect(messagesOfType(followerScope, 'status').at(-1)?.role).toBe('follower');
});

test('permanent discovery loss fails closed at the retry bound', async () => {
	const { followerScheduler, followerScope } = await setup({
		dropEveryDiscovery: true,
	});

	for (let retry = 0; retry < 40; retry += 1) {
		followerScheduler.runNext();
	}
	await flush();

	expect(messagesOfType(followerScope, 'fatal').at(-1)?.name).toBe(
		'EpicenterBrowserOwnerDiscoveryTimeoutError',
	);
	expect(followerScope.isClosed).toBe(true);
});

test('lost read request and reply are replayed within one owner session', async () => {
	const { hub, followerScheduler, followerScope, executions, values } =
		await setup();
	values.set(address.recordKey, 'durable-value');

	hub.dropNext('follower', 'request');
	followerScope.send({
		type: 'request',
		id: 1,
		operation: { kind: 'record', address },
	});
	followerScheduler.runNext();
	await flush();
	expect(messagesOfType(followerScope, 'result').at(-1)).toMatchObject({
		id: 1,
		value: 'durable-value',
	});

	hub.dropNext('owner', 'response');
	followerScope.send({
		type: 'request',
		id: 2,
		operation: { kind: 'record', address },
	});
	await flush();
	followerScheduler.runNext();
	await flush();
	expect(messagesOfType(followerScope, 'result').at(-1)).toMatchObject({
		id: 2,
		value: 'durable-value',
	});
	expect(executions.ownerReads).toBe(3);
});

test('permanent read reply loss returns a bounded timeout', async () => {
	const { hub, followerScheduler, followerScope, executions } = await setup();
	hub.dropEvery('owner', 'response');
	followerScope.send({
		type: 'request',
		id: 1,
		operation: { kind: 'record', address },
	});
	await flush();

	for (let retry = 0; retry < 40; retry += 1) {
		followerScheduler.runNext();
		await flush();
	}

	expect(messagesOfType(followerScope, 'error').at(-1)).toMatchObject({
		id: 1,
		name: 'EpicenterBrowserRequestTimeoutError',
	});
	expect(executions.ownerReads).toBe(40);
});

test('lost invalidation is repaired by the owner heartbeat token', async () => {
	const { hub, followerScheduler, followerScope, ownerScope } = await setup();
	hub.dropNext('owner', 'invalidation');

	ownerScope.send({
		type: 'request',
		id: 1,
		operation: {
			kind: 'local-write',
			intent: { address, op: 'replace', value: 'changed' },
		},
	});
	await flush();
	expect(messagesOfType(followerScope, 'invalidation')).toHaveLength(0);

	followerScheduler.runNext();
	await flush();
	expect(messagesOfType(followerScope, 'invalidation')).toEqual([
		{
			type: 'invalidation',
			token: 'owner-2',
			ownerSession: 'owner-1',
		},
	]);
});

test('pending read is replayed after owner handoff', async () => {
	const { hub, followerScope, ownerScope, executions, values } = await setup();
	values.set(address.recordKey, 'handoff-value');
	hub.dropNext('follower', 'request');
	followerScope.send({
		type: 'request',
		id: 1,
		operation: { kind: 'record', address },
	});

	ownerScope.send({ type: 'close' });
	await flush();

	expect(messagesOfType(followerScope, 'status').at(-1)?.role).toBe('owner');
	expect(messagesOfType(followerScope, 'result').at(-1)).toMatchObject({
		id: 1,
		value: 'handoff-value',
	});
	expect(executions.ownerReads).toBe(0);
	expect(executions.followerReads).toBe(1);
});

test('pending mutation fails owner-lost and is not replayed after handoff', async () => {
	const { hub, followerScope, ownerScope, executions } = await setup();
	hub.dropNext('owner', 'response');
	followerScope.send({
		type: 'request',
		id: 1,
		operation: {
			kind: 'local-write',
			intent: { address, op: 'replace', value: 'written-once' },
		},
	});
	await flush();
	expect(executions.ownerMutations).toBe(1);

	ownerScope.send({ type: 'close' });
	await flush();

	expect(messagesOfType(followerScope, 'error').at(-1)).toMatchObject({
		id: 1,
		name: 'EpicenterBrowserOwnerLostError',
	});
	expect(executions.ownerMutations).toBe(1);
	expect(executions.followerMutations).toBe(0);
});

test('pending document and blob mutations are never replayed after owner handoff', async () => {
	for (const operation of w3MutationOperations) {
		const { hub, followerScope, ownerScope, executions } = await setup();
		hub.dropNext('owner', 'response');
		followerScope.send({ type: 'request', id: 1, operation });
		await flush();
		expect(executions.ownerMutations, operation.kind).toBe(1);

		ownerScope.send({ type: 'close' });
		await flush();

		expect(
			messagesOfType(followerScope, 'error').at(-1),
			operation.kind,
		).toMatchObject({
			id: 1,
			name: 'EpicenterBrowserOwnerLostError',
		});
		expect(executions.ownerMutations, operation.kind).toBe(1);
		expect(executions.followerMutations, operation.kind).toBe(0);
	}
});

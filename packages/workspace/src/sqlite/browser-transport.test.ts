import { describe, expect, test } from 'bun:test';
import {
	createWorkspaceWorkerPort,
	exposeWorkspaceService,
	type WorkerWorkspaceService,
	type WorkspaceWorkerScope,
} from './browser-transport.js';
import type {
	WorkspaceCommitDelta,
	WorkspaceServiceRequest,
	WorkspaceServiceResponse,
} from './client.js';
import {
	parseWorkspaceWorkerCommand,
	parseWorkspaceWorkerEvent,
	WORKSPACE_WORKER_PROTOCOL,
	type WorkspaceWorkerEvent,
} from './service-protocol.js';

type Listener = (event: { data: unknown }) => void;

function createWorkerPair() {
	const pageListeners = new Map<string, Set<(event: unknown) => void>>();
	const workerListeners = new Set<Listener>();
	let terminated = false;

	function listenersFor(type: string): Set<(event: unknown) => void> {
		let listeners = pageListeners.get(type);
		if (!listeners) {
			listeners = new Set();
			pageListeners.set(type, listeners);
		}
		return listeners;
	}

	const worker = {
		postMessage(data: unknown) {
			const cloned = structuredClone(data);
			queueMicrotask(() => {
				if (terminated) return;
				for (const listener of [...workerListeners]) listener({ data: cloned });
			});
		},
		addEventListener(type: string, listener: (event: unknown) => void) {
			listenersFor(type).add(listener);
		},
		removeEventListener(type: string, listener: (event: unknown) => void) {
			listenersFor(type).delete(listener);
		},
		terminate() {
			terminated = true;
		},
	};

	const scope: WorkspaceWorkerScope = {
		postMessage(data) {
			const cloned = structuredClone(data);
			queueMicrotask(() => {
				if (terminated) return;
				for (const listener of [...listenersFor('message')]) {
					listener({ data: cloned });
				}
			});
		},
		addEventListener(_type, listener) {
			workerListeners.add(listener as Listener);
		},
	};

	return {
		worker: worker as unknown as Worker,
		scope,
		emitToPage(data: unknown) {
			for (const listener of [...listenersFor('message')]) {
				listener({ data });
			}
		},
		get terminated() {
			return terminated;
		},
	};
}

function createService(
	request: (
		request: WorkspaceServiceRequest,
	) => Promise<WorkspaceServiceResponse>,
	onDispose: () => Promise<void> = async () => undefined,
) {
	const observers = new Set<(delta: WorkspaceCommitDelta) => void>();
	return {
		request,
		observe(callback) {
			observers.add(callback);
			return () => observers.delete(callback);
		},
		async [Symbol.asyncDispose]() {
			await onDispose();
		},
		emit(delta: WorkspaceCommitDelta) {
			for (const observer of [...observers]) observer(delta);
		},
	} satisfies WorkerWorkspaceService & {
		emit(delta: WorkspaceCommitDelta): void;
	};
}

const description: WorkspaceServiceResponse = {
	kind: 'workspace',
	workspaceKind: 'standalone',
	workspaceId: 'transport-test',
	recordsDescriptor: 'transport descriptor',
	recordsSchemaHash: 'transport-schema',
};

describe('workspace worker protocol', () => {
	test('parsers accept exact JSON messages and reject malformed envelopes', () => {
		expect(
			parseWorkspaceWorkerCommand({
				protocol: WORKSPACE_WORKER_PROTOCOL,
				type: 'request',
				requestId: 1,
				request: { kind: 'describe' },
			}),
		).toEqual({
			protocol: WORKSPACE_WORKER_PROTOCOL,
			type: 'request',
			requestId: 1,
			request: { kind: 'describe' },
		});
		for (const invalid of [
			null,
			[],
			{ protocol: 'other', type: 'dispose', requestId: 1 },
			{
				protocol: WORKSPACE_WORKER_PROTOCOL,
				type: 'dispose',
				requestId: 0,
			},
			{
				protocol: WORKSPACE_WORKER_PROTOCOL,
				type: 'request',
				requestId: 1,
				request: { kind: 'describe', extra: true },
			},
		]) {
			expect(() => parseWorkspaceWorkerCommand(invalid)).toThrow('Invalid');
		}
		expect(() =>
			parseWorkspaceWorkerEvent({
				protocol: WORKSPACE_WORKER_PROTOCOL,
				type: 'delta',
				delta: { tables: { notes: { upserted: [{ id: '' }], removed: [] } } },
			}),
		).toThrow('Invalid');
		const recoveryReply = {
			protocol: WORKSPACE_WORKER_PROTOCOL,
			type: 'reply',
			requestId: 2,
			ok: true,
			response: {
				kind: 'recoveryCheckpoint',
				checkpoint: {
					format: 'epicenter.records-recovery/1',
					workspaceId: 'notes',
					recordsEpoch: 'epoch-1',
					recordsDescriptor: 'descriptor-1',
					recordsSchemaHash: 'schema-1',
					rows: [],
					pendingMutations: [],
				},
			},
		} satisfies WorkspaceWorkerEvent;
		expect(parseWorkspaceWorkerEvent(recoveryReply)).toEqual(recoveryReply);
		expect(() =>
			parseWorkspaceWorkerEvent({
				...recoveryReply,
				response: {
					...recoveryReply.response,
					checkpoint: {
						...recoveryReply.response.checkpoint,
						pendingMutations: [
							{
								actorId: 'actor-a',
								actorSequence: 0,
								operations: [],
							},
						],
					},
				},
			}),
		).toThrow('Invalid');
	});
});

describe('workspace worker transport', () => {
	test('an explicitly ignored initialization event does not poison commands', async () => {
		const pair = createWorkerPair();
		const service = createService(async () => description);
		let isFirstMessage = true;
		exposeWorkspaceService(pair.scope, Promise.resolve(service), {
			ignoreMessage(event) {
				if (!isFirstMessage) return false;
				isFirstMessage = false;
				return (event.data as { type?: unknown }).type === 'initialize';
			},
		});
		pair.worker.postMessage({ type: 'initialize' });

		const port = createWorkspaceWorkerPort(pair.worker, {
			onObserverError() {},
		});
		expect(await port.request({ kind: 'describe' })).toEqual(description);
		await port[Symbol.asyncDispose]();
	});

	test('describe is the readiness handshake and mutations publish before resolving', async () => {
		const pair = createWorkerPair();
		const timeline: string[] = [];
		let service!: ReturnType<typeof createService>;
		service = createService(async (request) => {
			if (request.kind === 'describe') return description;
			service.emit({
				tables: {
					notes: {
						upserted: [{ id: 'one', title: 'One' }],
						removed: [],
					},
				},
			});
			return { kind: 'mutation', results: [null] };
		});
		exposeWorkspaceService(pair.scope, Promise.resolve(service));
		const port = createWorkspaceWorkerPort(pair.worker, {
			onObserverError() {},
		});
		port.observe(() => timeline.push('delta'));

		expect(await port.request({ kind: 'describe' })).toEqual(description);
		await port
			.request({
				kind: 'mutate',
				mutations: [
					{
						kind: 'create',
						table: 'notes',
						row: { id: 'one', title: 'One' },
					},
				],
			})
			.then(() => timeline.push('resolved'));

		expect(timeline).toEqual(['delta', 'resolved']);
		await port[Symbol.asyncDispose]();
		expect(pair.terminated).toBe(true);
	});

	test('dispose drains admitted requests before closing the service', async () => {
		const pair = createWorkerPair();
		const timeline: string[] = [];
		let resolveMutation!: (response: WorkspaceServiceResponse) => void;
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const service = createService(
			async (request) => {
				if (request.kind === 'describe') return description;
				timeline.push('request-started');
				markStarted();
				return new Promise((resolve) => {
					resolveMutation = resolve;
				});
			},
			async () => {
				timeline.push('disposed');
			},
		);
		exposeWorkspaceService(pair.scope, Promise.resolve(service));
		const port = createWorkspaceWorkerPort(pair.worker, {
			onObserverError() {},
		});
		await port.request({ kind: 'describe' });
		const mutation = port.request({
			kind: 'mutate',
			mutations: [{ kind: 'remove', table: 'notes', rowId: 'one' }],
		});
		await started;
		const disposal = port[Symbol.asyncDispose]();
		expect(timeline).toEqual(['request-started']);
		resolveMutation({ kind: 'mutation', results: [null] });
		await mutation;
		await disposal;

		expect(timeline).toEqual(['request-started', 'disposed']);
	});

	test('malformed worker events fail closed and reject pending work', async () => {
		const pair = createWorkerPair();
		const port = createWorkspaceWorkerPort(pair.worker, {
			onObserverError() {},
			startupTimeoutMs: 0,
		});
		const pending = port.request({ kind: 'describe' });
		pair.emitToPage({ protocol: WORKSPACE_WORKER_PROTOCOL, type: 'unknown' });

		await expect(pending).rejects.toThrow('invalid protocol');
		expect(pair.terminated).toBe(true);
	});

	test('a disposal reply for normal work rejects that work and fails closed', async () => {
		const pair = createWorkerPair();
		const port = createWorkspaceWorkerPort(pair.worker, {
			onObserverError() {},
			startupTimeoutMs: 0,
		});
		const pending = port.request({ kind: 'describe' });
		pair.emitToPage({
			protocol: WORKSPACE_WORKER_PROTOCOL,
			type: 'disposed',
			requestId: 1,
		});

		await expect(pending).rejects.toThrow('unexpected disposal reply');
		expect(pair.terminated).toBe(true);
	});

	test('a request reply for disposal rejects disposal and fails closed', async () => {
		const pair = createWorkerPair();
		const port = createWorkspaceWorkerPort(pair.worker, {
			onObserverError() {},
			disposeTimeoutMs: 0,
		});
		const disposal = port[Symbol.asyncDispose]();
		pair.emitToPage({
			protocol: WORKSPACE_WORKER_PROTOCOL,
			type: 'reply',
			requestId: 1,
			ok: true,
			response: description,
		});

		await expect(disposal).rejects.toThrow('unexpected request reply');
		expect(pair.terminated).toBe(true);
	});

	test('startup timeout terminates a worker that never opens', async () => {
		const pair = createWorkerPair();
		const port = createWorkspaceWorkerPort(pair.worker, {
			onObserverError() {},
			startupTimeoutMs: 5,
		});

		await expect(port.request({ kind: 'describe' })).rejects.toThrow(
			'startup timed out',
		);
		expect(pair.terminated).toBe(true);
	});

	test('worker initialization errors preserve their remote name and message', async () => {
		const pair = createWorkerPair();
		exposeWorkspaceService(
			pair.scope,
			Promise.reject(new TypeError('SQLite initialization failed')),
		);
		const port = createWorkspaceWorkerPort(pair.worker, {
			onObserverError() {},
		});

		try {
			await port.request({ kind: 'describe' });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).name).toBe('TypeError');
			expect((error as Error).message).toBe('SQLite initialization failed');
		}
		await expect(port[Symbol.asyncDispose]()).rejects.toThrow(
			'SQLite initialization failed',
		);
		expect(pair.terminated).toBe(true);
	});

	test('observer failures are isolated and caller values clone at postMessage', async () => {
		const pair = createWorkerPair();
		const errors: unknown[] = [];
		let capturedTitle: unknown;
		let service!: ReturnType<typeof createService>;
		service = createService(async (request) => {
			if (request.kind === 'describe') return description;
			if (request.kind === 'mutate') {
				const mutation = request.mutations[0];
				capturedTitle = mutation?.kind === 'create' ? mutation.row.title : null;
			}
			service.emit({
				tables: { notes: { upserted: [{ id: 'one' }], removed: [] } },
			});
			return { kind: 'mutation', results: [null] };
		});
		exposeWorkspaceService(pair.scope, Promise.resolve(service));
		const port = createWorkspaceWorkerPort(pair.worker, {
			onObserverError: (error) => errors.push(error),
		});
		port.observe(() => {
			throw new Error('observer failed');
		});
		let peerCalls = 0;
		port.observe(() => peerCalls++);
		await port.request({ kind: 'describe' });
		const row = { id: 'one', title: 'Before' };
		const mutation = port.request({
			kind: 'mutate',
			mutations: [{ kind: 'create', table: 'notes', row }],
		});
		row.title = 'After';
		await mutation;

		expect(capturedTitle).toBe('Before');
		expect(peerCalls).toBe(1);
		expect(errors).toHaveLength(1);
		await port[Symbol.asyncDispose]();
	});
});

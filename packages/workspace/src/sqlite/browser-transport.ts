import type {
	WorkspaceCommitDelta,
	WorkspaceServicePort,
	WorkspaceServiceRequest,
	WorkspaceServiceResponse,
} from './client.js';
import type { OwnedWorkspaceServicePort } from './open.js';
import {
	parseWorkspaceWorkerCommand,
	parseWorkspaceWorkerEvent,
	type SerializedWorkerError,
	WORKSPACE_WORKER_PROTOCOL,
	type WorkspaceWorkerCommand,
	type WorkspaceWorkerEvent,
} from './service-protocol.js';

export type WorkspaceWorkerPortOptions = {
	startupTimeoutMs?: number;
	disposeTimeoutMs?: number;
	/** Receives page-side observer failures. Must not throw. */
	onObserverError(error: unknown): void;
};

type PendingRequest = {
	expected: 'reply' | 'disposed';
	resolve(value: WorkspaceServiceResponse | undefined): void;
	reject(error: Error): void;
};

/** Adapt one caller-owned module Worker to the workspace service port. */
export function createWorkspaceWorkerPort(
	worker: Worker,
	{
		startupTimeoutMs = 10_000,
		disposeTimeoutMs = 5_000,
		onObserverError,
	}: WorkspaceWorkerPortOptions,
): OwnedWorkspaceServicePort {
	const pending = new Map<number, PendingRequest>();
	const observers = new Set<(delta: WorkspaceCommitDelta) => void>();
	let nextRequestId = 1;
	let state: 'open' | 'disposing' | 'closed' | 'failed' = 'open';
	let disposePromise: Promise<void> | undefined;
	let startupTimer: ReturnType<typeof setTimeout> | undefined;

	function removeListeners(): void {
		worker.removeEventListener('message', onMessage);
		worker.removeEventListener('error', onWorkerError);
		worker.removeEventListener('messageerror', onMessageError);
	}

	function rejectPending(error: Error): void {
		for (const entry of pending.values()) entry.reject(error);
		pending.clear();
	}

	function fail(error: Error): void {
		if (state === 'closed' || state === 'failed') return;
		state = 'failed';
		if (startupTimer) clearTimeout(startupTimer);
		removeListeners();
		rejectPending(error);
		observers.clear();
		worker.terminate();
	}

	function remoteError(error: SerializedWorkerError): Error {
		const cause = new Error(error.message);
		cause.name = error.name;
		return cause;
	}

	function onMessage(event: MessageEvent<unknown>): void {
		let message: WorkspaceWorkerEvent;
		try {
			message = parseWorkspaceWorkerEvent(event.data);
		} catch (cause) {
			fail(
				new Error('Workspace worker sent an invalid protocol message', {
					cause,
				}),
			);
			return;
		}

		if (message.type === 'fatal') {
			fail(remoteError(message.error));
			return;
		}
		if (message.type === 'delta') {
			if (state === 'closed' || state === 'failed') return;
			for (const observer of [...observers]) {
				try {
					observer(structuredClone(message.delta));
				} catch (cause) {
					try {
						onObserverError(cause);
					} catch {
						// A broken sink must not poison the worker channel.
					}
				}
			}
			return;
		}

		const entry = pending.get(message.requestId);
		if (!entry) {
			fail(
				new Error(
					`Workspace worker replied to unknown request ${message.requestId}`,
				),
			);
			return;
		}
		if (message.type === 'disposed') {
			if (entry.expected !== 'disposed') {
				const error = new Error(
					'Workspace worker sent an unexpected disposal reply',
				);
				entry.reject(error);
				pending.delete(message.requestId);
				fail(error);
				return;
			}
			pending.delete(message.requestId);
			entry.resolve(undefined);
			return;
		}
		if (entry.expected !== 'reply') {
			const error = message.ok
				? new Error('Workspace worker sent an unexpected request reply')
				: remoteError(message.error);
			entry.reject(error);
			pending.delete(message.requestId);
			fail(error);
			return;
		}
		pending.delete(message.requestId);
		if (startupTimer) {
			clearTimeout(startupTimer);
			startupTimer = undefined;
		}
		if (message.ok) entry.resolve(message.response);
		else entry.reject(remoteError(message.error));
	}

	function onWorkerError(event: ErrorEvent): void {
		fail(new Error(event.message || 'Workspace worker crashed'));
	}

	function onMessageError(): void {
		fail(new Error('Workspace worker message could not be deserialized'));
	}

	worker.addEventListener('message', onMessage);
	worker.addEventListener('error', onWorkerError);
	worker.addEventListener('messageerror', onMessageError);

	function allocateRequestId(): number {
		if (nextRequestId > Number.MAX_SAFE_INTEGER) {
			const error = new Error('Workspace worker request ids are exhausted');
			fail(error);
			throw error;
		}
		return nextRequestId++;
	}

	function post<TResult extends WorkspaceServiceResponse | undefined>(
		command: WorkspaceWorkerCommand,
		expected: PendingRequest['expected'],
	): Promise<TResult> {
		return new Promise<TResult>((resolve, reject) => {
			pending.set(command.requestId, {
				expected,
				resolve: resolve as (
					value: WorkspaceServiceResponse | undefined,
				) => void,
				reject,
			});
			try {
				worker.postMessage(command);
			} catch (cause) {
				pending.delete(command.requestId);
				reject(
					cause instanceof Error
						? cause
						: new Error('Workspace worker postMessage failed', { cause }),
				);
			}
		});
	}

	function request(
		requestValue: WorkspaceServiceRequest,
	): Promise<WorkspaceServiceResponse> {
		if (state !== 'open') {
			return Promise.reject(new Error('Workspace worker port is disposed'));
		}
		const requestId = allocateRequestId();
		if (requestValue.kind === 'describe' && startupTimeoutMs > 0) {
			startupTimer ??= setTimeout(() => {
				fail(new Error('Workspace worker startup timed out'));
			}, startupTimeoutMs);
		}
		return post<WorkspaceServiceResponse>(
			{
				protocol: WORKSPACE_WORKER_PROTOCOL,
				type: 'request',
				requestId,
				request: requestValue,
			},
			'reply',
		);
	}

	return {
		request,
		observe(callback) {
			if (state !== 'open') {
				throw new Error('Workspace worker port is disposed');
			}
			observers.add(callback);
			return () => {
				observers.delete(callback);
			};
		},
		async [Symbol.asyncDispose]() {
			if (disposePromise) return disposePromise;
			if (state === 'closed' || state === 'failed') return;
			state = 'disposing';
			if (startupTimer) clearTimeout(startupTimer);
			const requestId = allocateRequestId();
			let disposeTimer: ReturnType<typeof setTimeout> | undefined;
			disposePromise = Promise.race([
				post<undefined>(
					{
						protocol: WORKSPACE_WORKER_PROTOCOL,
						type: 'dispose',
						requestId,
					},
					'disposed',
				),
				new Promise<never>((_, reject) => {
					if (disposeTimeoutMs <= 0) return;
					disposeTimer = setTimeout(
						() => reject(new Error('Workspace worker disposal timed out')),
						disposeTimeoutMs,
					);
				}),
			]).finally(() => {
				if (disposeTimer) clearTimeout(disposeTimer);
				state = 'closed';
				removeListeners();
				rejectPending(new Error('Workspace worker port is disposed'));
				observers.clear();
				worker.terminate();
			});
			return disposePromise;
		},
	};
}

export type WorkerWorkspaceService = WorkspaceServicePort & AsyncDisposable;

export type WorkspaceWorkerScope = {
	postMessage(message: WorkspaceWorkerEvent): void;
	addEventListener(
		type: 'message',
		listener: (event: MessageEvent<unknown>) => void,
	): void;
};

type ExposeWorkspaceServiceOptions = {
	ignoreMessage?(event: MessageEvent<unknown>): boolean;
};

/** Expose one asynchronously opened workspace service from a module Worker. */
export function exposeWorkspaceService(
	scope: WorkspaceWorkerScope,
	openService: Promise<WorkerWorkspaceService>,
	options: ExposeWorkspaceServiceOptions = {},
): void {
	let service: WorkerWorkspaceService | undefined;
	let stopObserving: (() => void) | undefined;
	let tail = Promise.resolve();
	let isDisposed = false;
	let isFatal = false;

	function post(message: WorkspaceWorkerEvent): void {
		if (!isFatal) scope.postMessage(message);
	}

	async function getService(): Promise<WorkerWorkspaceService> {
		if (service) return service;
		service = await openService;
		stopObserving = service.observe((delta) => {
			post({
				protocol: WORKSPACE_WORKER_PROTOCOL,
				type: 'delta',
				delta,
			});
		});
		return service;
	}

	function serializeError(cause: unknown): SerializedWorkerError {
		if (cause instanceof Error) {
			return { name: cause.name || 'Error', message: cause.message };
		}
		return { name: 'Error', message: String(cause) };
	}

	async function becomeFatal(cause: unknown): Promise<void> {
		if (isFatal) return;
		isFatal = true;
		try {
			scope.postMessage({
				protocol: WORKSPACE_WORKER_PROTOCOL,
				type: 'fatal',
				error: serializeError(cause),
			});
		} catch {
			// The page will also receive Worker error/messageerror when available.
		}
		try {
			const opened = await openService;
			stopObserving?.();
			await opened[Symbol.asyncDispose]();
		} catch {
			// The fatal protocol error remains the primary failure.
		}
	}

	async function handle(command: WorkspaceWorkerCommand): Promise<void> {
		if (isDisposed) {
			post({
				protocol: WORKSPACE_WORKER_PROTOCOL,
				type: 'reply',
				requestId: command.requestId,
				ok: false,
				error: { name: 'Error', message: 'Workspace worker is disposed' },
			});
			return;
		}
		if (command.type === 'dispose') {
			isDisposed = true;
			try {
				const opened = await getService();
				stopObserving?.();
				await opened[Symbol.asyncDispose]();
				post({
					protocol: WORKSPACE_WORKER_PROTOCOL,
					type: 'disposed',
					requestId: command.requestId,
				});
			} catch (cause) {
				post({
					protocol: WORKSPACE_WORKER_PROTOCOL,
					type: 'reply',
					requestId: command.requestId,
					ok: false,
					error: serializeError(cause),
				});
			}
			return;
		}

		try {
			const opened = await getService();
			const response = await opened.request(command.request);
			post({
				protocol: WORKSPACE_WORKER_PROTOCOL,
				type: 'reply',
				requestId: command.requestId,
				ok: true,
				response,
			});
		} catch (cause) {
			post({
				protocol: WORKSPACE_WORKER_PROTOCOL,
				type: 'reply',
				requestId: command.requestId,
				ok: false,
				error: serializeError(cause),
			});
		}
	}

	scope.addEventListener('message', (event) => {
		if (isFatal) return;
		if (options.ignoreMessage?.(event)) return;
		let command: WorkspaceWorkerCommand;
		try {
			command = parseWorkspaceWorkerCommand(event.data);
		} catch (cause) {
			const envelope =
				typeof event.data === 'object' && event.data !== null
					? (event.data as { protocol?: unknown; type?: unknown })
					: {};
			void becomeFatal(
				new Error(
					`Invalid workspace worker command envelope (protocol: ${String(envelope.protocol)}, type: ${String(envelope.type)})`,
					{ cause },
				),
			);
			return;
		}
		tail = tail
			.then(() => handle(command))
			.catch((cause) => becomeFatal(cause));
	});
}

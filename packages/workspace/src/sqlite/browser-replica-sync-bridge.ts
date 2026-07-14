import {
	type PullRequest,
	type PushRequest,
	parsePullRequest,
	parsePushRequest,
	parseRecordAuthorityOpenRequest,
	parseSnapshotChunkRequest,
	type SnapshotChunkRequest,
} from '@epicenter/record-sync';
import {
	type ReplicaAuthorityOpenRequest,
	type ReplicaSyncPort,
	ReplicaSyncRefusalError,
} from './replica.js';

const REPLICA_SYNC_BRIDGE_PROTOCOL =
	'epicenter.browser-replica-sync-port/1' as const;

type SyncOperation = 'openAuthority' | 'push' | 'pull' | 'snapshotChunk';

type BindCommand = {
	protocol: typeof REPLICA_SYNC_BRIDGE_PROTOCOL;
	type: 'bind';
	workspaceId: string;
};

type RequestCommand = {
	protocol: typeof REPLICA_SYNC_BRIDGE_PROTOCOL;
	type: 'request';
	requestId: number;
	operation: SyncOperation;
	request: unknown;
};

type CancelCommand = {
	protocol: typeof REPLICA_SYNC_BRIDGE_PROTOCOL;
	type: 'cancel';
	requestId: number;
};

type SyncError = {
	name: string;
	message: string;
	refusalReason?: string;
};

type SyncResponse =
	| {
			protocol: typeof REPLICA_SYNC_BRIDGE_PROTOCOL;
			type: 'response';
			requestId: number;
			ok: true;
			value: unknown;
	  }
	| {
			protocol: typeof REPLICA_SYNC_BRIDGE_PROTOCOL;
			type: 'response';
			requestId: number;
			ok: false;
			error: SyncError;
	  };

type PendingRequest = {
	resolve(value: unknown): void;
	reject(error: Error): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const keys = Object.keys(value).sort();
	return (
		keys.length === expected.length &&
		keys.every((key, index) => key === expected[index])
	);
}

function isRequestId(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

function parseCommand(
	value: unknown,
): BindCommand | RequestCommand | CancelCommand {
	if (!isRecord(value) || value.protocol !== REPLICA_SYNC_BRIDGE_PROTOCOL) {
		throw new Error('Invalid browser replica sync command');
	}
	if (value.type === 'bind') {
		if (
			!hasExactKeys(value, ['protocol', 'type', 'workspaceId']) ||
			typeof value.workspaceId !== 'string' ||
			value.workspaceId === ''
		) {
			throw new Error('Invalid browser replica sync bind command');
		}
		return value as BindCommand;
	}
	if (value.type === 'cancel') {
		if (
			!hasExactKeys(value, ['protocol', 'requestId', 'type']) ||
			!isRequestId(value.requestId)
		) {
			throw new Error('Invalid browser replica sync cancel command');
		}
		return value as CancelCommand;
	}
	if (
		value.type !== 'request' ||
		!hasExactKeys(value, [
			'operation',
			'protocol',
			'request',
			'requestId',
			'type',
		]) ||
		!isRequestId(value.requestId) ||
		(value.operation !== 'openAuthority' &&
			value.operation !== 'push' &&
			value.operation !== 'pull' &&
			value.operation !== 'snapshotChunk')
	) {
		throw new Error('Invalid browser replica sync request command');
	}
	return value as RequestCommand;
}

function parseResponse(value: unknown): SyncResponse {
	if (
		!isRecord(value) ||
		value.protocol !== REPLICA_SYNC_BRIDGE_PROTOCOL ||
		value.type !== 'response' ||
		!isRequestId(value.requestId) ||
		typeof value.ok !== 'boolean'
	) {
		throw new Error('Invalid browser replica sync response');
	}
	if (value.ok) {
		if (
			!hasExactKeys(value, ['ok', 'protocol', 'requestId', 'type', 'value'])
		) {
			throw new Error('Invalid browser replica sync success response');
		}
		return value as SyncResponse;
	}
	if (
		!hasExactKeys(value, ['error', 'ok', 'protocol', 'requestId', 'type']) ||
		!isRecord(value.error) ||
		(!hasExactKeys(value.error, ['message', 'name']) &&
			!hasExactKeys(value.error, ['message', 'name', 'refusalReason'])) ||
		typeof value.error.name !== 'string' ||
		typeof value.error.message !== 'string' ||
		(value.error.refusalReason !== undefined &&
			typeof value.error.refusalReason !== 'string')
	) {
		throw new Error('Invalid browser replica sync failure response');
	}
	return value as SyncResponse;
}

function parseAuthorityOpenRequest(
	value: unknown,
): ReplicaAuthorityOpenRequest {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			'protocolMajor',
			'recordsDescriptor',
			'recordsSchemaHash',
			'workspaceId',
		]) ||
		typeof value.workspaceId !== 'string' ||
		value.workspaceId === ''
	) {
		throw new Error('Invalid replica authority open request');
	}
	const request = parseRecordAuthorityOpenRequest({
		protocolMajor: value.protocolMajor,
		recordsDescriptor: value.recordsDescriptor,
		recordsSchemaHash: value.recordsSchemaHash,
	});
	return { ...request, workspaceId: value.workspaceId };
}

function parseOperationRequest(
	operation: SyncOperation,
	value: unknown,
):
	| ReplicaAuthorityOpenRequest
	| PushRequest
	| PullRequest
	| SnapshotChunkRequest {
	switch (operation) {
		case 'openAuthority':
			return parseAuthorityOpenRequest(value);
		case 'push':
			return parsePushRequest(value);
		case 'pull':
			return parsePullRequest(value);
		case 'snapshotChunk':
			return parseSnapshotChunkRequest(value);
	}
}

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function serializeError(cause: unknown): SyncError {
	const error = errorFrom(cause);
	return {
		name: error.name || 'Error',
		message: error.message,
		...(error instanceof ReplicaSyncRefusalError
			? { refusalReason: error.reason }
			: {}),
	};
}

function remoteError(value: SyncError): Error {
	if (value.refusalReason !== undefined) {
		return new ReplicaSyncRefusalError(value.refusalReason);
	}
	const error = new Error(value.message);
	error.name = value.name;
	return error;
}

/** Serve semantic record-sync operations through a page-owned authority port. */
export function attachBrowserReplicaSyncPort(
	port: MessagePort,
	sync: ReplicaSyncPort,
): () => void {
	const active = new Map<number, AbortController>();
	let isDisposed = false;
	let bindError: Error | undefined;

	async function handle(command: RequestCommand): Promise<void> {
		const controller = new AbortController();
		active.set(command.requestId, controller);
		try {
			if (bindError) throw bindError;
			const request = parseOperationRequest(command.operation, command.request);
			let value: unknown;
			switch (command.operation) {
				case 'openAuthority':
					value = await sync.openAuthority(
						request as ReplicaAuthorityOpenRequest,
						controller.signal,
					);
					break;
				case 'push':
					value = await sync.push(request as PushRequest, controller.signal);
					break;
				case 'pull':
					value = await sync.pull(request as PullRequest, controller.signal);
					break;
				case 'snapshotChunk':
					value = await sync.snapshotChunk(
						request as SnapshotChunkRequest,
						controller.signal,
					);
					break;
			}
			if (isDisposed) return;
			port.postMessage({
				protocol: REPLICA_SYNC_BRIDGE_PROTOCOL,
				type: 'response',
				requestId: command.requestId,
				ok: true,
				value,
			} satisfies SyncResponse);
		} catch (cause) {
			if (isDisposed) return;
			port.postMessage({
				protocol: REPLICA_SYNC_BRIDGE_PROTOCOL,
				type: 'response',
				requestId: command.requestId,
				ok: false,
				error: serializeError(cause),
			} satisfies SyncResponse);
		} finally {
			active.delete(command.requestId);
		}
	}

	function onMessage(event: MessageEvent<unknown>): void {
		if (isDisposed) return;
		let command: BindCommand | RequestCommand | CancelCommand;
		try {
			command = parseCommand(event.data);
		} catch {
			return;
		}
		if (command.type === 'bind') {
			try {
				sync.bindWorkspace(command.workspaceId);
			} catch (cause) {
				bindError = errorFrom(cause);
			}
			return;
		}
		if (command.type === 'cancel') {
			active.get(command.requestId)?.abort();
			return;
		}
		void handle(command);
	}

	port.addEventListener('message', onMessage);
	port.start();
	return () => {
		if (isDisposed) return;
		isDisposed = true;
		port.removeEventListener('message', onMessage);
		for (const controller of active.values()) controller.abort();
		active.clear();
		port.close();
	};
}

/** Build the Worker-side semantic port consumed by the replica runtime. */
export function createBrowserReplicaSyncPort(
	port: MessagePort,
): ReplicaSyncPort & Disposable {
	const pending = new Map<number, PendingRequest>();
	let nextRequestId = 1;
	let isDisposed = false;
	let workspaceId: string | undefined;

	function rejectAll(error: Error): void {
		for (const entry of pending.values()) entry.reject(error);
		pending.clear();
	}

	function onMessage(event: MessageEvent<unknown>): void {
		if (isDisposed) return;
		let response: SyncResponse;
		try {
			response = parseResponse(event.data);
		} catch (cause) {
			rejectAll(errorFrom(cause));
			return;
		}
		const entry = pending.get(response.requestId);
		if (!entry) return;
		pending.delete(response.requestId);
		if (response.ok) entry.resolve(response.value);
		else entry.reject(remoteError(response.error));
	}

	function request(
		operation: SyncOperation,
		value: unknown,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (isDisposed)
			return Promise.reject(new Error('Replica sync port is disposed'));
		if (!workspaceId) {
			return Promise.reject(new Error('Replica sync port is not bound'));
		}
		if (signal?.aborted) return Promise.reject(errorFrom(signal.reason));
		const requestId = nextRequestId++;
		const response = new Promise<unknown>((resolve, reject) => {
			pending.set(requestId, { resolve, reject });
		});
		const onAbort = () => {
			pending.get(requestId)?.reject(errorFrom(signal?.reason));
			pending.delete(requestId);
			port.postMessage({
				protocol: REPLICA_SYNC_BRIDGE_PROTOCOL,
				type: 'cancel',
				requestId,
			} satisfies CancelCommand);
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		port.postMessage({
			protocol: REPLICA_SYNC_BRIDGE_PROTOCOL,
			type: 'request',
			requestId,
			operation,
			request: value,
		} satisfies RequestCommand);
		return response.finally(() =>
			signal?.removeEventListener('abort', onAbort),
		);
	}

	port.addEventListener('message', onMessage);
	port.start();

	return {
		bindWorkspace(nextWorkspaceId) {
			if (workspaceId && workspaceId !== nextWorkspaceId) {
				throw new Error(
					'Replica sync port is already bound to another workspace',
				);
			}
			if (workspaceId) return;
			workspaceId = nextWorkspaceId;
			port.postMessage({
				protocol: REPLICA_SYNC_BRIDGE_PROTOCOL,
				type: 'bind',
				workspaceId: nextWorkspaceId,
			} satisfies BindCommand);
		},
		openAuthority(value, signal) {
			return request('openAuthority', value, signal);
		},
		push(value, signal) {
			return request('push', value, signal);
		},
		pull(value, signal) {
			return request('pull', value, signal);
		},
		snapshotChunk(value, signal) {
			return request('snapshotChunk', value, signal);
		},
		[Symbol.dispose]() {
			if (isDisposed) return;
			isDisposed = true;
			port.removeEventListener('message', onMessage);
			rejectAll(new Error('Replica sync port is disposed'));
			port.close();
		},
	};
}

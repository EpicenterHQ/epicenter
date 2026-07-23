import type {
	BrowserReplicaCandidateInbound,
	BrowserReplicaCandidateOutbound,
	BrowserReplicaCandidateStart,
	BrowserReplicaCoordinationMessage,
} from './browser-candidate-protocol.js';
import { openBrowserReplicaOwner } from './browser-owner.js';
import { createBrowserReplicaOwnerOperations } from './browser-owner-operations.js';
import type {
	BrowserReplicaOwnerMessage,
	BrowserReplicaOwnerResult,
	BrowserReplicaStoreOperation,
} from './browser-owner-protocol.js';

const DEFAULT_COORDINATION_ID = 'epicenter-data-replica-owner-v2';
const RETRY_INTERVAL_MS = 250;
const MAX_RETRY_TICKS = 40;

export type BrowserReplicaCandidateWorkerScope = {
	postMessage(message: BrowserReplicaCandidateOutbound): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: BrowserReplicaCandidateInbound }) => void,
	): void;
	close(): void;
};

type BrowserReplicaCandidateOwner = {
	execute(
		operation: BrowserReplicaStoreOperation,
	): BrowserReplicaOwnerResult | Promise<BrowserReplicaOwnerResult>;
	dispose(): Promise<void>;
};

type BrowserReplicaCandidateChannel = {
	onmessage: ((event: { data: unknown }) => void) | null;
	postMessage(message: BrowserReplicaCoordinationMessage): void;
	close(): void;
};

export type BrowserReplicaCandidateWorkerDependencies = {
	createChannel(name: string): BrowserReplicaCandidateChannel;
	openOwner(
		start: BrowserReplicaCandidateStart,
	): Promise<BrowserReplicaCandidateOwner>;
	randomUuid(): string;
	schedule(callback: () => void, delayMs: number): unknown;
	cancelSchedule(handle: unknown): void;
};

const defaultDependencies: BrowserReplicaCandidateWorkerDependencies = {
	createChannel(name) {
		const channel = new BroadcastChannel(name);
		let listener: ((event: { data: unknown }) => void) | null = null;
		return {
			get onmessage() {
				return listener;
			},
			set onmessage(nextListener) {
				listener = nextListener;
				channel.onmessage =
					nextListener === null
						? () => undefined
						: ({ data }) => nextListener({ data });
			},
			postMessage: (message) => channel.postMessage(message),
			close: () => channel.close(),
		};
	},
	async openOwner(start) {
		const owner = await openBrowserReplicaOwner({
			limits: start.limits,
			initialize: start.initialize,
			...(start.storage ?? {}),
		});
		const operations = createBrowserReplicaOwnerOperations(owner);
		return {
			execute: operations.execute,
			dispose: owner.dispose,
		};
	},
	randomUuid: () => crypto.randomUUID(),
	schedule: (callback, delayMs) => setTimeout(callback, delayMs),
	cancelSchedule: (handle) =>
		clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function serializeError(cause: unknown): { name: string; message: string } {
	if (cause instanceof Error)
		return { name: cause.name, message: cause.message };
	return { name: 'Error', message: String(cause) };
}

function isMutation(operation: BrowserReplicaStoreOperation): boolean {
	return (
		operation.kind === 'local-write' ||
		operation.kind === 'seal' ||
		operation.kind === 'settle' ||
		operation.kind === 'install-facts' ||
		operation.kind === 'append-local-document' ||
		operation.kind === 'install-accepted-document' ||
		operation.kind === 'document-publication' ||
		operation.kind === 'settle-document-publication' ||
		operation.kind === 'capture-blob' ||
		operation.kind === 'settle-blob-publication' ||
		operation.kind === 'sweep-blob-debris' ||
		operation.kind === 'erase'
	);
}

function isRetryable(operation: BrowserReplicaStoreOperation): boolean {
	return !isMutation(operation) && operation.kind !== 'reopen';
}

function ownerLostMessage(id: number): BrowserReplicaOwnerMessage {
	return {
		type: 'error',
		id,
		name: 'EpicenterBrowserOwnerLostError',
		message:
			'The browser replica owner changed before the operation result arrived',
	};
}

function requestTimeoutMessage(
	id: number,
	operation: BrowserReplicaStoreOperation,
): BrowserReplicaOwnerMessage {
	return {
		type: 'error',
		id,
		name: 'EpicenterBrowserRequestTimeoutError',
		message: isRetryable(operation)
			? 'The browser replica owner did not answer the operation within the retry bound'
			: 'The browser replica operation result is unknown and the operation was not replayed',
	};
}

type ForwardedOperation = {
	operation: BrowserReplicaStoreOperation;
	session: string;
	retryTicks: number;
};

/** Start one page's dedicated-worker ownership candidate. */
export function startBrowserReplicaCandidateWorker(
	scope: BrowserReplicaCandidateWorkerScope,
	dependencies: BrowserReplicaCandidateWorkerDependencies = defaultDependencies,
): void {
	const candidateId = dependencies.randomUuid();
	const queued = new Map<number, BrowserReplicaStoreOperation>();
	const forwarded = new Map<number, ForwardedOperation>();
	let channel: BrowserReplicaCandidateChannel | undefined;
	let owner: BrowserReplicaCandidateOwner | undefined;
	let ownerSession: string | undefined;
	let ownerReplacesSession: string | undefined;
	let ownerInvalidationToken: string | undefined;
	let currentSession: string | undefined;
	let observedInvalidationToken: string | undefined;
	let ownerTail = Promise.resolve();
	let retryHandle: unknown;
	let discoveryAttempts = 0;
	let isStarted = false;
	let isClosed = false;

	function postStatus(role: 'waiting' | 'follower' | 'owner'): void {
		scope.postMessage({
			type: 'status',
			role,
			ownerSession: currentSession ?? null,
		});
	}

	function respond(
		candidate: string,
		message: BrowserReplicaOwnerMessage,
		session: string,
	): void {
		if (candidate === candidateId) {
			scope.postMessage(message);
			return;
		}
		channel?.postMessage({
			version: 2,
			type: 'response',
			candidateId: candidate,
			ownerSession: session,
			message,
		} satisfies BrowserReplicaCoordinationMessage);
	}

	function emitInvalidation(session: string): void {
		const token = dependencies.randomUuid();
		ownerInvalidationToken = token;
		observedInvalidationToken = token;
		scope.postMessage({
			type: 'invalidation',
			token,
			ownerSession: session,
		});
		channel?.postMessage({
			version: 2,
			type: 'invalidation',
			ownerSession: session,
			token,
		} satisfies BrowserReplicaCoordinationMessage);
	}

	function observeInvalidation(session: string, token: string): void {
		if (session !== currentSession || observedInvalidationToken === token)
			return;
		observedInvalidationToken = token;
		scope.postMessage({
			type: 'invalidation',
			token,
			ownerSession: session,
		});
	}

	function executeFor(
		candidate: string,
		id: number,
		operation: BrowserReplicaStoreOperation,
		session: string,
	): void {
		if (owner === undefined || ownerSession !== session) return;
		const executingOwner = owner;
		ownerTail = ownerTail.then(async () => {
			try {
				const value = await executingOwner.execute(operation);
				respond(candidate, { type: 'result', id, value }, session);
				if (isMutation(operation)) emitInvalidation(session);
			} catch (cause) {
				const error = serializeError(cause);
				respond(candidate, { type: 'error', id, ...error }, session);
			}
		});
	}

	function sendDiscover(): void {
		channel?.postMessage({
			version: 2,
			type: 'discover',
			candidateId,
			knownOwnerSession: currentSession ?? null,
		} satisfies BrowserReplicaCoordinationMessage);
	}

	function sendForwarded(
		id: number,
		forwardedOperation: ForwardedOperation,
	): void {
		channel?.postMessage({
			version: 2,
			type: 'request',
			candidateId,
			ownerSession: forwardedOperation.session,
			id,
			operation: forwardedOperation.operation,
		} satisfies BrowserReplicaCoordinationMessage);
	}

	function route(id: number, operation: BrowserReplicaStoreOperation): void {
		const session = currentSession;
		if (session === undefined) {
			queued.set(id, operation);
			return;
		}
		if (ownerSession === session) {
			executeFor(candidateId, id, operation, session);
			return;
		}
		const forwardedOperation = { operation, session, retryTicks: 0 };
		forwarded.set(id, forwardedOperation);
		sendForwarded(id, forwardedOperation);
	}

	function acceptOwner(
		session: string,
		replacesSession: string | null,
		invalidationToken: string | null,
		isLocalAcquisition = false,
	): void {
		const previous = currentSession;
		if (
			!isLocalAcquisition &&
			previous !== undefined &&
			previous !== session &&
			replacesSession !== previous
		)
			return;
		currentSession = session;
		discoveryAttempts = 0;
		if (previous !== undefined && previous !== session) {
			observedInvalidationToken = undefined;
			observeInvalidation(session, invalidationToken ?? session);
			for (const [id, forwardedOperation] of forwarded) {
				if (forwardedOperation.session !== previous) continue;
				if (!isRetryable(forwardedOperation.operation)) {
					forwarded.delete(id);
					scope.postMessage(ownerLostMessage(id));
					continue;
				}
				forwardedOperation.session = session;
				forwardedOperation.retryTicks = 0;
				if (ownerSession === session) {
					forwarded.delete(id);
					executeFor(candidateId, id, forwardedOperation.operation, session);
				} else {
					sendForwarded(id, forwardedOperation);
				}
			}
		} else if (previous === session && invalidationToken !== null) {
			observeInvalidation(session, invalidationToken);
		} else if (previous === undefined) {
			observedInvalidationToken = invalidationToken ?? undefined;
		}
		postStatus(ownerSession === session ? 'owner' : 'follower');
		for (const [id, operation] of queued) {
			queued.delete(id);
			route(id, operation);
		}
	}

	function retry(): void {
		if (isClosed) return;
		if (currentSession === undefined) {
			if (discoveryAttempts >= MAX_RETRY_TICKS) {
				scope.postMessage({
					type: 'fatal',
					name: 'EpicenterBrowserOwnerDiscoveryTimeoutError',
					message:
						'No browser replica owner answered within the discovery retry bound',
				});
				void close().catch((cause: unknown) => {
					const error = serializeError(cause);
					scope.postMessage({ type: 'fatal', ...error });
				});
				return;
			}
			discoveryAttempts += 1;
			sendDiscover();
		} else if (ownerSession !== currentSession) {
			sendDiscover();
		}

		for (const [id, forwardedOperation] of forwarded) {
			if (forwardedOperation.session !== currentSession) continue;
			forwardedOperation.retryTicks += 1;
			if (forwardedOperation.retryTicks >= MAX_RETRY_TICKS) {
				forwarded.delete(id);
				scope.postMessage(
					requestTimeoutMessage(id, forwardedOperation.operation),
				);
				continue;
			}
			if (isRetryable(forwardedOperation.operation)) {
				sendForwarded(id, forwardedOperation);
			}
		}
		retryHandle = dependencies.schedule(retry, RETRY_INTERVAL_MS);
	}

	function receiveCoordination(
		message: BrowserReplicaCoordinationMessage,
	): void {
		if (isClosed || message.version !== 2) return;
		switch (message.type) {
			case 'discover':
				if (ownerSession === undefined) return;
				channel?.postMessage({
					version: 2,
					type: 'owner',
					candidateId,
					recipientCandidateId: message.candidateId,
					ownerSession,
					replacesOwnerSession: message.knownOwnerSession,
					invalidationToken: ownerInvalidationToken ?? null,
				} satisfies BrowserReplicaCoordinationMessage);
				return;
			case 'owner':
				if (
					message.recipientCandidateId !== null &&
					message.recipientCandidateId !== candidateId
				)
					return;
				acceptOwner(
					message.ownerSession,
					message.replacesOwnerSession,
					message.invalidationToken,
				);
				return;
			case 'request':
				executeFor(
					message.candidateId,
					message.id,
					message.operation,
					message.ownerSession,
				);
				return;
			case 'response':
				if (
					message.candidateId !== candidateId ||
					forwarded.get(message.message.id)?.session !== message.ownerSession
				)
					return;
				forwarded.delete(message.message.id);
				scope.postMessage(message.message);
				return;
			case 'invalidation':
				observeInvalidation(message.ownerSession, message.token);
				return;
		}
	}

	async function compete(start: BrowserReplicaCandidateStart): Promise<void> {
		try {
			const opened = await dependencies.openOwner(start);
			if (isClosed) {
				await opened.dispose();
				return;
			}
			owner = opened;
			ownerReplacesSession = currentSession;
			ownerSession = dependencies.randomUuid();
			acceptOwner(ownerSession, ownerReplacesSession ?? null, null, true);
			channel?.postMessage({
				version: 2,
				type: 'owner',
				candidateId,
				recipientCandidateId: null,
				ownerSession,
				replacesOwnerSession: ownerReplacesSession ?? null,
				invalidationToken: ownerInvalidationToken ?? null,
			} satisfies BrowserReplicaCoordinationMessage);
		} catch (cause) {
			if (isClosed) return;
			const error = serializeError(cause);
			scope.postMessage({ type: 'fatal', ...error });
			await close().catch((cleanupCause: unknown) => {
				const cleanupError = serializeError(cleanupCause);
				scope.postMessage({ type: 'fatal', ...cleanupError });
			});
		}
	}

	async function close(): Promise<void> {
		if (isClosed) return;
		isClosed = true;
		for (const id of queued.keys()) scope.postMessage(ownerLostMessage(id));
		for (const id of forwarded.keys()) scope.postMessage(ownerLostMessage(id));
		queued.clear();
		forwarded.clear();
		if (retryHandle !== undefined) dependencies.cancelSchedule(retryHandle);
		retryHandle = undefined;
		await ownerTail.catch(() => undefined);
		await owner?.dispose();
		owner = undefined;
		channel?.close();
		channel = undefined;
		scope.postMessage({ type: 'closed' });
		scope.close();
	}

	scope.addEventListener('message', ({ data: message }) => {
		if (message.type === 'start') {
			if (isStarted) {
				scope.postMessage({
					type: 'fatal',
					name: 'Error',
					message: 'browser replica candidate is already started',
				});
				return;
			}
			isStarted = true;
			channel = dependencies.createChannel(
				message.coordinationId ?? DEFAULT_COORDINATION_ID,
			);
			channel.onmessage = ({ data }) =>
				receiveCoordination(data as BrowserReplicaCoordinationMessage);
			postStatus('waiting');
			discoveryAttempts = 1;
			sendDiscover();
			retryHandle = dependencies.schedule(retry, RETRY_INTERVAL_MS);
			void compete(message);
			return;
		}
		if (message.type === 'request') {
			if (!isStarted || isClosed) {
				scope.postMessage({
					type: 'error',
					id: message.id,
					name: 'Error',
					message: 'browser replica candidate is not available',
				});
				return;
			}
			route(message.id, message.operation);
			return;
		}
		void close().catch((cause: unknown) => {
			const error = serializeError(cause);
			scope.postMessage({ type: 'fatal', ...error });
		});
	});
}

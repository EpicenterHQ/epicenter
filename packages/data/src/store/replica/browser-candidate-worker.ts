import type {
	BrowserReplicaCandidateInbound,
	BrowserReplicaCandidateOutbound,
	BrowserReplicaCandidateStart,
	BrowserReplicaCoordinationMessage,
} from './browser-candidate-protocol.js';
import {
	type BrowserReplicaOwner,
	openBrowserReplicaOwner,
} from './browser-owner.js';
import { createBrowserReplicaOwnerOperations } from './browser-owner-operations.js';
import type {
	BrowserReplicaOwnerMessage,
	BrowserReplicaStoreOperation,
} from './browser-owner-protocol.js';

const DEFAULT_COORDINATION_ID = 'epicenter-data-replica-owner-v1';

export type BrowserReplicaCandidateWorkerScope = {
	postMessage(message: BrowserReplicaCandidateOutbound): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: BrowserReplicaCandidateInbound }) => void,
	): void;
	close(): void;
};

function serializeError(cause: unknown): { name: string; message: string } {
	if (cause instanceof Error)
		return { name: cause.name, message: cause.message };
	return { name: 'Error', message: String(cause) };
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

/** Start one page's dedicated-worker ownership candidate. */
export function startBrowserReplicaCandidateWorker(
	scope: BrowserReplicaCandidateWorkerScope,
): void {
	const candidateId = crypto.randomUUID();
	const queued = new Map<number, BrowserReplicaStoreOperation>();
	const forwarded = new Map<number, string>();
	let channel: BroadcastChannel | undefined;
	let owner: BrowserReplicaOwner | undefined;
	let ownerOperations:
		| ReturnType<typeof createBrowserReplicaOwnerOperations>
		| undefined;
	let ownerSession: string | undefined;
	let ownerReplacesSession: string | undefined;
	let stopOwnerInvalidations: (() => void) | undefined;
	let currentSession: string | undefined;
	let ownerTail = Promise.resolve();
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
			version: 1,
			type: 'response',
			candidateId: candidate,
			ownerSession: session,
			message,
		} satisfies BrowserReplicaCoordinationMessage);
	}

	function emitInvalidation(session: string): void {
		const token = crypto.randomUUID();
		scope.postMessage({
			type: 'invalidation',
			token,
			ownerSession: session,
		});
		channel?.postMessage({
			version: 1,
			type: 'invalidation',
			ownerSession: session,
			token,
		} satisfies BrowserReplicaCoordinationMessage);
	}

	function executeFor(
		candidate: string,
		id: number,
		operation: BrowserReplicaStoreOperation,
		session: string,
	): void {
		if (ownerOperations === undefined || ownerSession !== session) return;
		ownerTail = ownerTail.then(async () => {
			try {
				const value = await ownerOperations?.execute(operation);
				respond(candidate, { type: 'result', id, value }, session);
			} catch (cause) {
				const error = serializeError(cause);
				respond(candidate, { type: 'error', id, ...error }, session);
			}
		});
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
		forwarded.set(id, session);
		channel?.postMessage({
			version: 1,
			type: 'request',
			candidateId,
			ownerSession: session,
			id,
			operation,
		} satisfies BrowserReplicaCoordinationMessage);
	}

	function acceptOwner(
		session: string,
		replacesSession: string | null,
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
		if (previous !== undefined && previous !== session) {
			for (const [id, forwardedSession] of forwarded) {
				if (forwardedSession !== previous) continue;
				forwarded.delete(id);
				scope.postMessage(ownerLostMessage(id));
			}
		}
		postStatus(ownerSession === session ? 'owner' : 'follower');
		for (const [id, operation] of queued) {
			queued.delete(id);
			route(id, operation);
		}
	}

	function receiveCoordination(
		message: BrowserReplicaCoordinationMessage,
	): void {
		if (message.version !== 1) return;
		switch (message.type) {
			case 'discover':
				if (ownerSession === undefined) return;
				channel?.postMessage({
					version: 1,
					type: 'owner',
					candidateId,
					ownerSession,
					replacesOwnerSession: ownerReplacesSession ?? null,
				} satisfies BrowserReplicaCoordinationMessage);
				return;
			case 'owner':
				acceptOwner(message.ownerSession, message.replacesOwnerSession);
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
					forwarded.get(message.message.id) !== message.ownerSession
				)
					return;
				forwarded.delete(message.message.id);
				scope.postMessage(message.message);
				return;
			case 'invalidation':
				if (message.ownerSession !== currentSession) return;
				scope.postMessage({
					type: 'invalidation',
					token: message.token,
					ownerSession: message.ownerSession,
				});
				return;
		}
	}

	async function compete(start: BrowserReplicaCandidateStart): Promise<void> {
		try {
			const opened = await openBrowserReplicaOwner({
				limits: start.limits,
				initialize: start.initialize,
				...(start.storage ?? {}),
			});
			if (isClosed) {
				await opened.dispose();
				return;
			}
			owner = opened;
			ownerOperations = createBrowserReplicaOwnerOperations(opened);
			ownerReplacesSession = currentSession;
			ownerSession = crypto.randomUUID();
			stopOwnerInvalidations = opened.subscribeInvalidation(() => {
				if (ownerSession !== undefined) emitInvalidation(ownerSession);
			});
			acceptOwner(ownerSession, ownerReplacesSession ?? null, true);
			channel?.postMessage({
				version: 1,
				type: 'owner',
				candidateId,
				ownerSession,
				replacesOwnerSession: ownerReplacesSession ?? null,
			} satisfies BrowserReplicaCoordinationMessage);
		} catch (cause) {
			if (isClosed) return;
			const error = serializeError(cause);
			scope.postMessage({ type: 'fatal', ...error });
		}
	}

	async function close(): Promise<void> {
		if (isClosed) return;
		isClosed = true;
		for (const id of queued.keys()) scope.postMessage(ownerLostMessage(id));
		for (const id of forwarded.keys()) scope.postMessage(ownerLostMessage(id));
		queued.clear();
		forwarded.clear();
		await ownerTail.catch(() => undefined);
		stopOwnerInvalidations?.();
		stopOwnerInvalidations = undefined;
		await owner?.dispose();
		owner = undefined;
		ownerOperations = undefined;
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
			channel = new BroadcastChannel(
				message.coordinationId ?? DEFAULT_COORDINATION_ID,
			);
			channel.onmessage = ({ data }) =>
				receiveCoordination(data as BrowserReplicaCoordinationMessage);
			postStatus('waiting');
			channel.postMessage({
				version: 1,
				type: 'discover',
				candidateId,
			} satisfies BrowserReplicaCoordinationMessage);
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

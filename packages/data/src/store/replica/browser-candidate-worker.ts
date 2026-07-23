import type { RecordAddress } from '../../protocol/v1/index.js';
import { openBrowserRuntimeOwner } from '../../runtime/browser-owner.js';
import type {
	BrowserAuthorityRequest,
	BrowserAuthorityResult,
} from '../../runtime/browser-protocol.js';
import type { AuthorityCarrier, SyncStatus } from '../../runtime/supervisor.js';
import type {
	BrowserReplicaCandidateInbound,
	BrowserReplicaCandidateOutbound,
	BrowserReplicaCandidateStart,
	BrowserReplicaCoordinationMessage,
} from './browser-candidate-protocol.js';
import type {
	BrowserReplicaCandidateMessage,
	BrowserReplicaCandidateOperation,
	BrowserReplicaCandidateResult,
} from './browser-owner-protocol.js';

const DEFAULT_COORDINATION_ID = 'epicenter-data-replica-owner-v3';
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
	status?(): SyncStatus;
	execute(
		operation: BrowserReplicaCandidateOperation,
	): BrowserReplicaCandidateResult | Promise<BrowserReplicaCandidateResult>;
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
		runtime: {
			carrier: AuthorityCarrier<Blob> | null;
			onInvalidate(addresses: RecordAddress[]): void;
			onAuthorityReplacement(): void;
			onStatus(status: SyncStatus): void;
		},
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
	async openOwner(start, runtime) {
		return openBrowserRuntimeOwner({
			start,
			carrier: runtime.carrier,
			events: {
				onInvalidate: runtime.onInvalidate,
				onAuthorityReplacement: runtime.onAuthorityReplacement,
				onStatus: runtime.onStatus,
			},
		});
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

function isMutation(operation: BrowserReplicaCandidateOperation): boolean {
	return (
		operation.kind === 'runtime-attach' ||
		operation.kind === 'runtime-sign-in' ||
		operation.kind === 'runtime-sign-out' ||
		operation.kind === 'runtime-table-update' ||
		operation.kind === 'runtime-delete-record' ||
		operation.kind === 'runtime-value-write' ||
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

function isRetryable(operation: BrowserReplicaCandidateOperation): boolean {
	return !isMutation(operation) && operation.kind !== 'reopen';
}

function ownerLostMessage(id: number): BrowserReplicaCandidateMessage {
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
	operation: BrowserReplicaCandidateOperation,
): BrowserReplicaCandidateMessage {
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
	operation: BrowserReplicaCandidateOperation;
	session: string;
	retryTicks: number;
};

function invalidatedAddresses(
	operation: BrowserReplicaCandidateOperation,
): RecordAddress[] {
	switch (operation.kind) {
		case 'local-write':
			return [operation.intent.address];
		case 'runtime-table-update':
		case 'runtime-value-write':
			return [operation.intent.address];
		case 'runtime-delete-record':
			return [operation.address];
		case 'install-facts':
			return operation.page.response.facts.map((fact) => fact.address);
		case 'settle':
			return operation.response.facts.map((fact) => fact.address);
		case 'append-local-document':
		case 'install-accepted-document':
		case 'document-publication':
		case 'settle-document-publication':
		case 'capture-blob':
		case 'settle-blob-publication':
			return [operation.address];
		default:
			return [];
	}
}

/** Start one page's dedicated-worker ownership candidate. */
export function startBrowserReplicaCandidateWorker(
	scope: BrowserReplicaCandidateWorkerScope,
	dependencies: BrowserReplicaCandidateWorkerDependencies = defaultDependencies,
): void {
	const candidateId = dependencies.randomUuid();
	const queued = new Map<number, BrowserReplicaCandidateOperation>();
	const forwarded = new Map<number, ForwardedOperation>();
	const authorityRequests = new Map<
		number,
		{
			resolve(value: BrowserAuthorityResult): void;
			reject(cause: unknown): void;
		}
	>();
	let channel: BrowserReplicaCandidateChannel | undefined;
	let owner: BrowserReplicaCandidateOwner | undefined;
	let ownerSession: string | undefined;
	let ownerReplacesSession: string | undefined;
	let ownerInvalidationToken: string | undefined;
	let ownerInvalidationSequence = 0;
	let ownerInvalidationAddresses: RecordAddress[] = [];
	let ownerInvalidationAll = false;
	let ownerAuthorityReplacementToken: string | undefined;
	let currentSession: string | undefined;
	let observedInvalidationToken: string | undefined;
	let observedInvalidationSequence: number | undefined;
	let observedAuthorityReplacementToken: string | undefined;
	let ownerTail = Promise.resolve();
	let retryHandle: unknown;
	let discoveryAttempts = 0;
	let isStarted = false;
	let isClosed = false;
	let nextAuthorityRequestId = 0;

	function postStatus(role: 'waiting' | 'follower' | 'owner'): void {
		scope.postMessage({
			type: 'status',
			role,
			ownerSession: currentSession ?? null,
		});
	}

	function respond(
		candidate: string,
		message: BrowserReplicaCandidateMessage,
		session: string,
	): void {
		if (candidate === candidateId) {
			scope.postMessage(message);
			return;
		}
		channel?.postMessage({
			version: 3,
			type: 'response',
			candidateId: candidate,
			ownerSession: session,
			message,
		} satisfies BrowserReplicaCoordinationMessage);
	}

	function emitInvalidation(
		session: string,
		addresses: readonly RecordAddress[],
		all = false,
	): void {
		if (!all && addresses.length === 0) return;
		const token = dependencies.randomUuid();
		ownerInvalidationSequence += 1;
		ownerInvalidationToken = token;
		ownerInvalidationAddresses = addresses.map((address) =>
			structuredClone(address),
		);
		ownerInvalidationAll = all;
		observedInvalidationToken = token;
		observedInvalidationSequence = ownerInvalidationSequence;
		scope.postMessage({
			type: 'invalidation',
			token,
			sequence: ownerInvalidationSequence,
			ownerSession: session,
			addresses: addresses.map((address) => structuredClone(address)),
			all,
		});
		channel?.postMessage({
			version: 3,
			type: 'invalidation',
			ownerSession: session,
			token,
			sequence: ownerInvalidationSequence,
			addresses: addresses.map((address) => structuredClone(address)),
			all,
		} satisfies BrowserReplicaCoordinationMessage);
	}

	function observeInvalidation(
		session: string,
		token: string,
		sequence: number,
		addresses: readonly RecordAddress[],
		all: boolean,
	): void {
		if (
			session !== currentSession ||
			observedInvalidationToken === token ||
			(observedInvalidationSequence !== undefined &&
				sequence <= observedInvalidationSequence)
		)
			return;
		const missed =
			observedInvalidationSequence === undefined ||
			sequence !== observedInvalidationSequence + 1;
		observedInvalidationToken = token;
		observedInvalidationSequence = sequence;
		scope.postMessage({
			type: 'invalidation',
			token,
			sequence,
			ownerSession: session,
			addresses: addresses.map((address) => structuredClone(address)),
			all: all || missed,
		});
	}

	function emitStatus(session: string, status: SyncStatus): void {
		if (session !== ownerSession) return;
		scope.postMessage({
			type: 'runtime-sync-status',
			ownerSession: session,
			status: structuredClone(status),
		});
		channel?.postMessage({
			version: 3,
			type: 'runtime-sync-status',
			ownerSession: session,
			status: structuredClone(status),
		} satisfies BrowserReplicaCoordinationMessage);
	}

	function emitAuthorityReplacement(session: string): void {
		if (session !== ownerSession) return;
		const token = dependencies.randomUuid();
		ownerAuthorityReplacementToken = token;
		observedAuthorityReplacementToken = token;
		scope.postMessage({
			type: 'runtime-authority-replacement',
			ownerSession: session,
			token,
		});
		channel?.postMessage({
			version: 3,
			type: 'runtime-authority-replacement',
			ownerSession: session,
			token,
		} satisfies BrowserReplicaCoordinationMessage);
	}

	function observeAuthorityReplacement(session: string, token: string): void {
		if (
			session !== currentSession ||
			token === observedAuthorityReplacementToken
		) {
			return;
		}
		observedAuthorityReplacementToken = token;
		scope.postMessage({
			type: 'runtime-authority-replacement',
			ownerSession: session,
			token,
		});
	}

	function requestAuthority(
		request: BrowserAuthorityRequest,
	): Promise<BrowserAuthorityResult> {
		if (isClosed)
			return Promise.reject(new Error('browser replica candidate is closed'));
		const id = nextAuthorityRequestId++;
		return new Promise((resolve, reject) => {
			authorityRequests.set(id, { resolve, reject });
			scope.postMessage({ type: 'authority-request', id, request });
		});
	}

	const authorityCarrier: AuthorityCarrier<Blob> = {
		async fetchFacts(request) {
			return (await requestAuthority({ kind: 'facts', request })) as Awaited<
				ReturnType<AuthorityCarrier<Blob>['fetchFacts']>
			>;
		},
		async submit(bytes) {
			return (await requestAuthority({
				kind: 'submission',
				bytes,
			})) as Awaited<ReturnType<AuthorityCarrier<Blob>['submit']>>;
		},
		async publishDocument(address, publication) {
			return (await requestAuthority({
				kind: 'document',
				address,
				publication,
			})) as Awaited<ReturnType<AuthorityCarrier<Blob>['publishDocument']>>;
		},
		async publishBlob(address, publication, bytes) {
			return (await requestAuthority({
				kind: 'blob',
				address,
				publication,
				bytes,
			})) as Awaited<ReturnType<AuthorityCarrier<Blob>['publishBlob']>>;
		},
	};

	function executeFor(
		candidate: string,
		id: number,
		operation: BrowserReplicaCandidateOperation,
		session: string,
	): void {
		if (owner === undefined || ownerSession !== session) return;
		const executingOwner = owner;

		function settleStaleExecution(): void {
			if (candidate === candidateId) {
				if (isRetryable(operation)) route(id, operation);
				else scope.postMessage(ownerLostMessage(id));
				return;
			}
			if (!isRetryable(operation)) {
				respond(candidate, ownerLostMessage(id), session);
			}
		}

		function isCurrentOwner(): boolean {
			return (
				owner === executingOwner &&
				ownerSession === session &&
				currentSession === session
			);
		}

		ownerTail = ownerTail.then(async () => {
			if (!isCurrentOwner()) {
				settleStaleExecution();
				return;
			}
			try {
				const value = await executingOwner.execute(operation);
				if (!isCurrentOwner()) {
					settleStaleExecution();
					return;
				}
				respond(candidate, { type: 'result', id, value }, session);
				if (
					operation.kind === 'runtime-attach' &&
					operation.choice === 'discard'
				) {
					emitInvalidation(session, [], true);
				} else {
					emitInvalidation(session, invalidatedAddresses(operation));
				}
			} catch (cause) {
				if (!isCurrentOwner()) {
					settleStaleExecution();
					return;
				}
				const error = serializeError(cause);
				respond(candidate, { type: 'error', id, ...error }, session);
			}
		});
	}

	function sendDiscover(): void {
		channel?.postMessage({
			version: 3,
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
			version: 3,
			type: 'request',
			candidateId,
			ownerSession: forwardedOperation.session,
			id,
			operation: forwardedOperation.operation,
		} satisfies BrowserReplicaCoordinationMessage);
	}

	function route(
		id: number,
		operation: BrowserReplicaCandidateOperation,
	): void {
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
		invalidationSequence: number,
		invalidationAddresses: readonly RecordAddress[],
		invalidationAll: boolean,
		authorityReplacementToken: string | null,
		runtimeStatus: SyncStatus | null,
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
			observedInvalidationSequence = undefined;
			observedAuthorityReplacementToken =
				authorityReplacementToken ?? undefined;
			scope.postMessage({
				type: 'invalidation',
				token: invalidationToken ?? session,
				sequence: invalidationSequence,
				ownerSession: session,
				addresses: invalidationAddresses.map((address) =>
					structuredClone(address),
				),
				all: true,
			});
			observedInvalidationToken = invalidationToken ?? session;
			observedInvalidationSequence = invalidationSequence;
			if (authorityReplacementToken !== null) {
				scope.postMessage({
					type: 'runtime-authority-replacement',
					ownerSession: session,
					token: authorityReplacementToken,
				});
			}
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
			observeInvalidation(
				session,
				invalidationToken,
				invalidationSequence,
				invalidationAddresses,
				invalidationAll,
			);
		} else if (previous === undefined) {
			observedInvalidationToken = invalidationToken ?? undefined;
			observedInvalidationSequence = invalidationSequence;
			observedAuthorityReplacementToken =
				authorityReplacementToken ?? undefined;
		}
		if (previous === session && authorityReplacementToken !== null) {
			observeAuthorityReplacement(session, authorityReplacementToken);
		}
		postStatus(ownerSession === session ? 'owner' : 'follower');
		if (runtimeStatus !== null) {
			scope.postMessage({
				type: 'runtime-sync-status',
				ownerSession: session,
				status: structuredClone(runtimeStatus),
			});
		}
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
		if (isClosed || message.version !== 3) return;
		switch (message.type) {
			case 'discover':
				if (ownerSession === undefined) return;
				channel?.postMessage({
					version: 3,
					type: 'owner',
					candidateId,
					recipientCandidateId: message.candidateId,
					ownerSession,
					replacesOwnerSession: message.knownOwnerSession,
					invalidationToken: ownerInvalidationToken ?? null,
					invalidationSequence: ownerInvalidationSequence,
					invalidationAddresses: ownerInvalidationAddresses.map((address) =>
						structuredClone(address),
					),
					invalidationAll: ownerInvalidationAll,
					authorityReplacementToken: ownerAuthorityReplacementToken ?? null,
					runtimeStatus: owner?.status?.() ?? null,
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
					message.invalidationSequence,
					message.invalidationAddresses,
					message.invalidationAll,
					message.authorityReplacementToken,
					message.runtimeStatus,
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
				observeInvalidation(
					message.ownerSession,
					message.token,
					message.sequence,
					message.addresses,
					message.all,
				);
				return;
			case 'runtime-sync-status':
				if (message.ownerSession !== currentSession) return;
				scope.postMessage({
					type: 'runtime-sync-status',
					ownerSession: message.ownerSession,
					status: structuredClone(message.status),
				});
				return;
			case 'runtime-authority-replacement':
				observeAuthorityReplacement(message.ownerSession, message.token);
				return;
		}
	}

	async function compete(start: BrowserReplicaCandidateStart): Promise<void> {
		try {
			const opened = await dependencies.openOwner(start, {
				carrier: start.hasCarrier === true ? authorityCarrier : null,
				onInvalidate(addresses) {
					const session = ownerSession;
					if (session !== undefined) emitInvalidation(session, addresses);
				},
				onAuthorityReplacement() {
					const session = ownerSession;
					if (session !== undefined) emitAuthorityReplacement(session);
				},
				onStatus(status) {
					const session = ownerSession;
					if (session !== undefined) emitStatus(session, status);
				},
			});
			if (isClosed) {
				await opened.dispose();
				return;
			}
			owner = opened;
			ownerReplacesSession = currentSession;
			ownerSession = dependencies.randomUuid();
			acceptOwner(
				ownerSession,
				ownerReplacesSession ?? null,
				null,
				0,
				[],
				false,
				null,
				opened.status?.() ?? null,
				true,
			);
			channel?.postMessage({
				version: 3,
				type: 'owner',
				candidateId,
				recipientCandidateId: null,
				ownerSession,
				replacesOwnerSession: ownerReplacesSession ?? null,
				invalidationToken: ownerInvalidationToken ?? null,
				invalidationSequence: ownerInvalidationSequence,
				invalidationAddresses: ownerInvalidationAddresses.map((address) =>
					structuredClone(address),
				),
				invalidationAll: ownerInvalidationAll,
				authorityReplacementToken: ownerAuthorityReplacementToken ?? null,
				runtimeStatus: opened.status?.() ?? null,
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
		const closure = new Error('browser replica candidate closed');
		for (const request of authorityRequests.values()) request.reject(closure);
		authorityRequests.clear();
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
		if (
			message.type === 'authority-result' ||
			message.type === 'authority-error'
		) {
			const request = authorityRequests.get(message.id);
			if (request === undefined) return;
			authorityRequests.delete(message.id);
			if (message.type === 'authority-result') request.resolve(message.value);
			else {
				const cause = new Error(message.message);
				cause.name = message.name;
				request.reject(cause);
			}
			return;
		}
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

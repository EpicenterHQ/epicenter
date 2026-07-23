import type { Logger } from 'wellcrafted/logger';
import type { RecordSyncTransport } from '../record-sync-supervisor.js';
import {
	RecordAuthorityLifetimeMismatchError,
	RecordSyncTransportCancelledError,
} from '../record-sync-supervisor.js';
import type { SyncCredentialProvider } from '../sync-types.js';
import type {
	BrowserRecordAuthorityErrorCode,
	BrowserRecordAuthorityOperation,
	BrowserRecordAuthorityResult,
} from './protocol.js';

type Capability = {
	candidateId: string;
	transportKey: number;
	hasCredentials: boolean;
	order: number;
};

type AuthorityResponse =
	| { type: 'result'; result: BrowserRecordAuthorityResult }
	| {
			type: 'error';
			code: BrowserRecordAuthorityErrorCode;
			activeAuthorityLifetime?: string;
	  };

type PendingAuthority = {
	capability: Capability;
	operation: BrowserRecordAuthorityOperation;
	timeout: ReturnType<typeof setTimeout>;
	resolve(result: BrowserRecordAuthorityResult): void;
	reject(cause: unknown): void;
};

const DEFAULT_AUTHORITY_TIMEOUT_MS = 30_000;

/** Own one elected worker's page-local authority capability selection. */
export function createBrowserRecordAuthorityRelay({
	sendRequest,
	sendCancel,
	authorityTimeoutMs = DEFAULT_AUTHORITY_TIMEOUT_MS,
	log,
}: {
	sendRequest(
		capability: { candidateId: string; transportKey: number },
		authorityId: number,
		operation: BrowserRecordAuthorityOperation,
	): void;
	sendCancel(
		capability: { candidateId: string; transportKey: number },
		authorityId: number,
	): void;
	authorityTimeoutMs?: number;
	log: Logger;
}) {
	const capabilities = new Map<string, Capability>();
	const pending = new Map<number, PendingAuthority>();
	const credentialListeners = new Set<() => void>();
	let nextOrder = 0;
	let nextAuthorityId = 0;
	let selected: Capability | undefined;
	let isDisposed = false;
	let automaticWakeBlocked = false;

	function select(): void {
		const previous = selected;
		selected = [...capabilities.values()]
			.filter((capability) => capability.hasCredentials)
			.sort((left, right) => right.order - left.order)[0];
		if (
			previous?.candidateId !== selected?.candidateId ||
			previous?.transportKey !== selected?.transportKey
		) {
			for (const [authorityId, entry] of pending) {
				if (
					entry.capability.candidateId === selected?.candidateId &&
					entry.capability.transportKey === selected.transportKey
				)
					continue;
				cancelPending(
					authorityId,
					new Error('Selected browser authority transport changed'),
				);
			}
		}
		if (!automaticWakeBlocked) {
			for (const listener of credentialListeners) listener();
		}
	}

	function cancelPending(authorityId: number, cause: Error): void {
		const entry = pending.get(authorityId);
		if (entry === undefined) return;
		pending.delete(authorityId);
		clearTimeout(entry.timeout);
		try {
			sendCancel(entry.capability, authorityId);
		} catch (cleanupCause) {
			log.error(
				new Error('Browser authority cancellation failed', {
					cause: cleanupCause,
				}),
			);
		}
		const isAmbiguousMutation = entry.operation.kind !== 'read-facts';
		if (isAmbiguousMutation) automaticWakeBlocked = true;
		entry.reject(
			isAmbiguousMutation
				? new RecordSyncTransportCancelledError(cause.message, { cause })
				: cause,
		);
	}

	function call(
		operation: BrowserRecordAuthorityOperation,
	): Promise<BrowserRecordAuthorityResult> {
		if (isDisposed) {
			return Promise.reject(new Error('Browser authority relay is disposed'));
		}
		const capability = selected;
		if (capability === undefined) {
			return Promise.reject(
				new Error('No credentialed browser authority transport is available'),
			);
		}
		const authorityId = ++nextAuthorityId;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				const current = capabilities.get(capability.candidateId);
				if (current?.transportKey === capability.transportKey) {
					capabilities.delete(capability.candidateId);
				}
				cancelPending(
					authorityId,
					new Error('Browser authority transport timed out'),
				);
				select();
			}, authorityTimeoutMs);
			pending.set(authorityId, {
				capability,
				operation,
				timeout,
				resolve,
				reject,
			});
			try {
				sendRequest(capability, authorityId, operation);
			} catch (cause) {
				clearTimeout(timeout);
				pending.delete(authorityId);
				capabilities.delete(capability.candidateId);
				select();
				reject(
					new Error('Browser authority request was not dispatched', { cause }),
				);
			}
		});
	}

	function requireKind(
		operation: BrowserRecordAuthorityOperation,
		result: BrowserRecordAuthorityResult,
	): void {
		if (operation.kind !== result.kind) {
			throw new Error(
				`Browser authority returned '${result.kind}' for '${operation.kind}'`,
			);
		}
	}

	const transport: RecordSyncTransport<Blob> = {
		async readFacts(request) {
			const result = await call({ kind: 'read-facts', request });
			requireKind({ kind: 'read-facts', request }, result);
			if (result.kind !== 'read-facts') throw new Error('unreachable result');
			return result.response;
		},
		async submit(request) {
			const result = await call({ kind: 'submit', request });
			requireKind({ kind: 'submit', request }, result);
			if (result.kind !== 'submit') throw new Error('unreachable result');
			return result.response;
		},
		async publishDocument(request) {
			const result = await call({ kind: 'publish-document', request });
			requireKind({ kind: 'publish-document', request }, result);
			if (result.kind !== 'publish-document')
				throw new Error('unreachable result');
			return result.acceptance;
		},
		async publishBlob({ request, bytes }) {
			const result = await call({ kind: 'publish-blob', request, bytes });
			requireKind({ kind: 'publish-blob', request, bytes }, result);
			if (result.kind !== 'publish-blob') throw new Error('unreachable result');
			return result.acceptance;
		},
	};

	const credentials: SyncCredentialProvider = {
		get() {
			return selected === undefined ? undefined : 'page-owned-credential';
		},
		subscribe(listener) {
			credentialListeners.add(listener);
			return () => credentialListeners.delete(listener);
		},
	};

	return {
		transport,
		credentials,
		has(candidateId: string, transportKey: number): boolean {
			return capabilities.get(candidateId)?.transportKey === transportKey;
		},
		register(
			candidateId: string,
			transportKey: number,
			hasCredentials: boolean,
		): void {
			if (isDisposed) return;
			automaticWakeBlocked = false;
			const previous = capabilities.get(candidateId);
			if (previous !== undefined && previous.transportKey !== transportKey) {
				for (const [authorityId, entry] of pending) {
					if (entry.capability.candidateId !== candidateId) continue;
					cancelPending(
						authorityId,
						new Error('Browser authority transport was replaced'),
					);
				}
			}
			capabilities.set(candidateId, {
				candidateId,
				transportKey,
				hasCredentials,
				order: ++nextOrder,
			});
			select();
		},
		credentialsChanged(
			candidateId: string,
			transportKey: number,
			hasCredentials: boolean,
		): void {
			const capability = capabilities.get(candidateId);
			if (capability?.transportKey !== transportKey) return;
			automaticWakeBlocked = false;
			capability.hasCredentials = hasCredentials;
			capability.order = ++nextOrder;
			select();
		},
		remove(candidateId: string, transportKey: number): void {
			const capability = capabilities.get(candidateId);
			if (capability?.transportKey !== transportKey) return;
			capabilities.delete(candidateId);
			select();
		},
		handleResponse(
			candidateId: string,
			transportKey: number,
			authorityId: number,
			response: AuthorityResponse,
		): void {
			const entry = pending.get(authorityId);
			if (
				entry === undefined ||
				entry.capability.candidateId !== candidateId ||
				entry.capability.transportKey !== transportKey
			)
				return;
			pending.delete(authorityId);
			clearTimeout(entry.timeout);
			if (response.type === 'result') {
				try {
					requireKind(entry.operation, response.result);
					entry.resolve(response.result);
				} catch (cause) {
					entry.reject(cause);
				}
				return;
			}
			if (
				response.code === 'lifetime-mismatch' &&
				response.activeAuthorityLifetime !== undefined
			) {
				entry.reject(
					new RecordAuthorityLifetimeMismatchError(
						response.activeAuthorityLifetime,
					),
				);
				return;
			}
			if (
				response.code === 'transport-failed' &&
				entry.operation.kind !== 'read-facts'
			) {
				automaticWakeBlocked = true;
				entry.reject(
					new RecordSyncTransportCancelledError(
						'Browser authority mutation outcome is ambiguous',
					),
				);
				return;
			}
			entry.reject(
				new Error(
					response.code === 'transport-unavailable'
						? 'Browser authority transport is unavailable'
						: 'Browser authority transport failed',
				),
			);
		},
		dispose(): void {
			if (isDisposed) return;
			isDisposed = true;
			for (const authorityId of [...pending.keys()]) {
				cancelPending(
					authorityId,
					new Error('Browser authority relay is disposed'),
				);
			}
			capabilities.clear();
			selected = undefined;
			credentialListeners.clear();
		},
	};
}

export type BrowserRecordAuthorityRelay = ReturnType<
	typeof createBrowserRecordAuthorityRelay
>;

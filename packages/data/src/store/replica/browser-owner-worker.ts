import { openBrowserRuntimeOwner } from '../../runtime/browser-owner.js';
import type {
	BrowserAuthorityRequest,
	BrowserAuthorityResult,
} from '../../runtime/browser-protocol.js';
import type { AuthorityCarrier } from '../../runtime/supervisor.js';
import type {
	BrowserReplicaOwnerInbound,
	BrowserReplicaOwnerOutbound,
	BrowserReplicaOwnerStart,
} from './browser-owner-protocol.js';

export type BrowserReplicaOwnerWorkerScope = {
	postMessage(message: BrowserReplicaOwnerOutbound): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: BrowserReplicaOwnerInbound }) => void,
	): void;
	close?(): void;
};

function serializeError(cause: unknown): { name: string; message: string } {
	if (cause instanceof Error) {
		return { name: cause.name, message: cause.message };
	}
	return { name: 'Error', message: String(cause) };
}

/**
 * Run the one origin replica owner inside this dedicated worker (ADR-0165).
 *
 * The worker owns the Web Lock, the SQLite connection, the replica runtime,
 * and the synchronization supervisor. It admits no second owner and performs
 * no election: `open` either wins the lock and reports `ready`, or reports one
 * `fatal` refusal that the page presents. Terminating the worker is what ends
 * live ownership.
 *
 * The authority carrier stays on the page, because only the page holds the
 * credentials. The supervisor reaches it by posting an `authority-request` and
 * awaiting the page's answer.
 */
export function startBrowserReplicaOwnerWorker(
	scope: BrowserReplicaOwnerWorkerScope,
): void {
	const authorityRequests = new Map<
		number,
		{
			resolve(value: BrowserAuthorityResult): void;
			reject(cause: unknown): void;
		}
	>();
	let owner: Awaited<ReturnType<typeof openBrowserRuntimeOwner>> | undefined;
	let requestTail = Promise.resolve();
	let nextAuthorityRequestId = 0;
	let isClosed = false;

	function requestAuthority(
		request: BrowserAuthorityRequest,
	): Promise<BrowserAuthorityResult> {
		if (isClosed) return Promise.reject(new Error('owner worker is closed'));
		const id = nextAuthorityRequestId++;
		const answered = Promise.withResolvers<BrowserAuthorityResult>();
		authorityRequests.set(id, answered);
		scope.postMessage({ type: 'authority-request', id, request });
		return answered.promise;
	}

	/**
	 * Reconstruct the page's carrier as a proxy, or refuse to have one at all.
	 *
	 * `hasCarrier` is fixed at open, so this worker's authorization posture is
	 * decided once by the page that started it (ADR-0178). A pull path is
	 * deliberately absent: the supervisor drains obligations, and `pull()` runs
	 * on the page beside the live Y.Docs.
	 */
	function carrierFor(
		start: BrowserReplicaOwnerStart,
	): AuthorityCarrier<Blob> | null {
		if (start.hasCarrier !== true) return null;
		return {
			async fetchFacts(request) {
				return (await requestAuthority({
					kind: 'facts',
					request,
				})) as Awaited<ReturnType<AuthorityCarrier<Blob>['fetchFacts']>>;
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
	}

	async function start(message: BrowserReplicaOwnerStart): Promise<void> {
		if (owner !== undefined) {
			throw new Error('browser replica owner is already open');
		}
		owner = await openBrowserRuntimeOwner({
			start: message,
			carrier: carrierFor(message),
			events: {
				onInvalidate(addresses) {
					scope.postMessage({ type: 'invalidation', addresses, all: false });
				},
				onAuthorityReplacement() {
					scope.postMessage({ type: 'invalidation', addresses: [], all: true });
				},
				onStatus(status) {
					scope.postMessage({ type: 'runtime-sync-status', status });
				},
			},
		});
	}

	async function close(): Promise<void> {
		if (isClosed) return;
		isClosed = true;
		const opened = owner;
		owner = undefined;
		for (const pending of authorityRequests.values()) {
			pending.reject(new Error('owner worker is closed'));
		}
		authorityRequests.clear();
		await opened?.dispose();
	}

	scope.addEventListener('message', ({ data: message }) => {
		switch (message.type) {
			case 'authority-result': {
				authorityRequests.get(message.id)?.resolve(message.value);
				authorityRequests.delete(message.id);
				return;
			}
			case 'authority-error': {
				const error = new Error(message.message);
				error.name = message.name;
				authorityRequests.get(message.id)?.reject(error);
				authorityRequests.delete(message.id);
				return;
			}
			case 'start': {
				requestTail = requestTail.then(async () => {
					try {
						await start(message);
						scope.postMessage({ type: 'ready' });
					} catch (cause) {
						scope.postMessage({ type: 'fatal', ...serializeError(cause) });
					}
				});
				return;
			}
			case 'close': {
				requestTail = requestTail.then(async () => {
					try {
						await close();
						scope.postMessage({ type: 'closed' });
					} catch (cause) {
						scope.postMessage({ type: 'fatal', ...serializeError(cause) });
					} finally {
						scope.close?.();
					}
				});
				return;
			}
			case 'request': {
				requestTail = requestTail.then(async () => {
					try {
						if (owner === undefined) {
							throw new Error('browser replica owner is not open');
						}
						const value = await owner.execute(message.operation);
						scope.postMessage({ type: 'result', id: message.id, value });
					} catch (cause) {
						scope.postMessage({
							type: 'error',
							id: message.id,
							...serializeError(cause),
						});
					}
				});
				return;
			}
		}
	});
}

import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';

import type { Exchange, Replica, ReplicaError } from './replica/index.js';

const DEFAULT_EXCHANGE_INTERVAL_MS = 30_000;
const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

/**
 * `pending` reports drained synchronization with parked refused work still
 * owed at specific addresses; refused work is never reported as `idle`.
 */
export type SyncState =
	| 'local'
	| 'syncing'
	| 'idle'
	| 'pending'
	| 'offline'
	| 'authentication-required';

export type SyncStatus = {
	state: SyncState;
	lastError: Error | undefined;
};

export type SyncCredentialProvider = {
	get(): string | undefined;
	subscribe?(listener: () => void): () => void;
};

export type SyncSupervisorSession = {
	exchange: Exchange;
	credentials?: SyncCredentialProvider;
};

export type SyncSchedule = (task: () => void, delayMs: number) => () => void;

export function createSyncSupervisor({
	replica,
	exchangeIntervalMs = DEFAULT_EXCHANGE_INTERVAL_MS,
	schedule = scheduleTimeout,
	log = createLogger('data/sync'),
}: {
	replica: Replica;
	exchangeIntervalMs?: number;
	schedule?: SyncSchedule;
	log?: Logger;
}) {
	const listeners = new Set<(status: SyncStatus) => void>();
	let status: SyncStatus = { state: 'local', lastError: undefined };
	let session: SyncSupervisorSession | undefined;
	let stopCredentials: (() => void) | undefined;
	let cancelScheduled: (() => void) | undefined;
	let running: Promise<Result<void, ReplicaError>> | undefined;
	let runningGeneration: number | undefined;
	let runRequested = false;
	let retryAttempt = 0;
	let generation = 0;
	let isDisposed = false;
	const stopOutbox = replica.subscribeOutbox(() => {
		void requestExchange();
	});

	function setStatus(next: SyncStatus): void {
		if (
			status.state === next.state &&
			status.lastError?.message === next.lastError?.message
		) {
			return;
		}
		status = next;
		for (const listener of listeners) {
			try {
				listener(status);
			} catch (cause) {
				log.error(new Error('Sync status subscriber threw', { cause }));
			}
		}
	}

	function hasCredentials(): boolean {
		return (
			session?.credentials?.get() !== undefined ||
			session?.credentials === undefined
		);
	}

	function cancelWake(): void {
		cancelScheduled?.();
		cancelScheduled = undefined;
	}

	function scheduleWake(delayMs: number): void {
		cancelWake();
		cancelScheduled = schedule(() => {
			cancelScheduled = undefined;
			void requestExchange();
		}, delayMs);
	}

	function retryDelay(): number {
		const delay = Math.min(BASE_RETRY_MS * 2 ** retryAttempt, MAX_RETRY_MS);
		retryAttempt += 1;
		return delay;
	}

	async function drain(
		activeGeneration: number,
	): Promise<Result<void, ReplicaError>> {
		let lastResult: Result<void, ReplicaError> = Ok(undefined);
		while (
			runRequested &&
			!isDisposed &&
			activeGeneration === generation &&
			session !== undefined
		) {
			runRequested = false;
			if (!hasCredentials()) {
				setStatus({
					state: 'authentication-required',
					lastError: undefined,
				});
				return Ok(undefined);
			}
			setStatus({ state: 'syncing', lastError: status.lastError });
			lastResult = await replica.synchronize(session.exchange);
			if (activeGeneration !== generation || isDisposed) return lastResult;
			if (lastResult.error !== null) {
				const error = new Error(extractErrorMessage(lastResult.error), {
					cause: lastResult.error,
				});
				setStatus({ state: 'offline', lastError: error });
				if (lastResult.error.name === 'TransportFailed') {
					scheduleWake(retryDelay());
				}
				return lastResult;
			}
			retryAttempt = 0;
			const parked = replica.parked();
			setStatus({
				state:
					parked.error === null && parked.data.length > 0 ? 'pending' : 'idle',
				lastError: undefined,
			});
		}
		if (!isDisposed && activeGeneration === generation && hasCredentials()) {
			scheduleWake(exchangeIntervalMs);
		}
		return lastResult;
	}

	function requestExchange(): Promise<Result<void, ReplicaError>> {
		if (isDisposed || session === undefined)
			return Promise.resolve(Ok(undefined));
		cancelWake();
		runRequested = true;
		if (running !== undefined) {
			return runningGeneration === generation
				? running
				: running.then(() => requestExchange());
		}
		const activeGeneration = generation;
		runningGeneration = activeGeneration;
		running = drain(activeGeneration).finally(() => {
			running = undefined;
			runningGeneration = undefined;
			if (runRequested && !isDisposed && activeGeneration === generation) {
				void requestExchange();
			}
		});
		return running;
	}

	function credentialsChanged(): void {
		if (isDisposed || session === undefined) return;
		generation += 1;
		cancelWake();
		if (!hasCredentials()) {
			runRequested = false;
			setStatus({
				state: 'authentication-required',
				lastError: undefined,
			});
			return;
		}
		void requestExchange();
	}

	return {
		async attach(
			nextSession: SyncSupervisorSession,
		): Promise<Result<void, ReplicaError>> {
			if (isDisposed) throw new Error('Sync supervisor is disposed');
			generation += 1;
			cancelWake();
			stopCredentials?.();
			session = nextSession;
			stopCredentials =
				nextSession.credentials?.subscribe?.(credentialsChanged);
			if (!hasCredentials()) {
				setStatus({
					state: 'authentication-required',
					lastError: undefined,
				});
				return Ok(undefined);
			}
			return requestExchange();
		},
		requestExchange,
		get status(): SyncStatus {
			return status;
		},
		subscribe(listener: (next: SyncStatus) => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose(): void {
			if (isDisposed) return;
			isDisposed = true;
			generation += 1;
			cancelWake();
			stopCredentials?.();
			stopCredentials = undefined;
			stopOutbox();
			session = undefined;
			listeners.clear();
		},
	};
}

function scheduleTimeout(task: () => void, delayMs: number): () => void {
	const timer = setTimeout(task, delayMs);
	return () => clearTimeout(timer);
}

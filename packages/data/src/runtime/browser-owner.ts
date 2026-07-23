import type { RecordAddress } from '../protocol/v1/index.js';
import type { BrowserReplicaCandidateStart } from '../store/replica/browser-candidate-protocol.js';
import {
	type BrowserReplicaOwner,
	openBrowserReplicaOwner,
} from '../store/replica/browser-owner.js';
import { createBrowserReplicaOwnerOperations } from '../store/replica/browser-owner-operations.js';
import type {
	BrowserReplicaCandidateOperation,
	BrowserReplicaCandidateResult,
	BrowserReplicaStoreOperation,
} from '../store/replica/browser-owner-protocol.js';
import {
	type AuthorityCarrier,
	createRuntimeSupervisor,
	type SyncStatus,
} from './supervisor.js';

type BrowserRuntimeOwnerEvents = {
	onInvalidate(addresses: RecordAddress[]): void;
	onAuthorityReplacement(): void;
	onStatus(status: SyncStatus): void;
};

export type OpenBrowserRuntimeOwnerOptions = {
	start: BrowserReplicaCandidateStart;
	carrier: AuthorityCarrier<Blob> | null;
	events: BrowserRuntimeOwnerEvents;
	openPhysicalOwner?: typeof openBrowserReplicaOwner;
};

function nudgesSupervisor(operation: BrowserReplicaStoreOperation): boolean {
	switch (operation.kind) {
		case 'local-write':
		case 'runtime-table-update':
		case 'runtime-delete-record':
		case 'runtime-value-write':
		case 'append-local-document':
		case 'capture-blob':
			return true;
		default:
			return false;
	}
}

/**
 * Bind one W4 supervisor to the elected physical browser replica owner.
 *
 * Page candidates may come and go, but only the Web Lock holder constructs this
 * object. Durable state and every automatic publication drain therefore share
 * the same owner lifetime.
 */
export async function openBrowserRuntimeOwner({
	start,
	carrier,
	events,
	openPhysicalOwner = openBrowserReplicaOwner,
}: OpenBrowserRuntimeOwnerOptions) {
	let physical: BrowserReplicaOwner | undefined;
	try {
		physical = await openPhysicalOwner({
			limits: start.limits,
			initialize: start.initialize,
			...(start.storage ?? {}),
		});
		const opened = physical;
		const operations = createBrowserReplicaOwnerOperations(opened);
		let isSignedOut = false;
		const supervisor = createRuntimeSupervisor({
			store: opened.store,
			blobs: opened.blobs,
			carrier,
			onInvalidate: events.onInvalidate,
			onAuthorityReplacement: events.onAuthorityReplacement,
			onStatus: events.onStatus,
		});
		if (carrier !== null && opened.store.attachment() !== null) {
			supervisor.nudge();
		}

		return {
			status(): SyncStatus {
				return supervisor.status();
			},
			async execute(
				operation: BrowserReplicaCandidateOperation,
			): Promise<BrowserReplicaCandidateResult> {
				switch (operation.kind) {
					case 'runtime-attach': {
						const outcome = supervisor.attach(
							operation.attachment,
							operation.choice,
						);
						return { kind: outcome.kind };
					}
					case 'runtime-status':
						return supervisor.status();
					case 'runtime-nudge':
						if (carrier === null || isSignedOut) supervisor.nudge();
						else supervisor.setCarrier(carrier);
						return undefined;
					case 'runtime-sign-in':
						isSignedOut = false;
						supervisor.setCarrier(carrier);
						return undefined;
					case 'runtime-sign-out':
						isSignedOut = true;
						supervisor.setCarrier(null);
						return undefined;
					default: {
						const value = await operations.execute(operation);
						if (nudgesSupervisor(operation)) supervisor.nudge();
						return value;
					}
				}
			},
			async dispose(): Promise<void> {
				const failures: unknown[] = [];
				try {
					await supervisor.dispose();
				} catch (cause) {
					failures.push(cause);
				}
				try {
					await opened.dispose();
				} catch (cause) {
					failures.push(cause);
				}
				if (failures.length === 1) throw failures[0];
				if (failures.length > 1) {
					throw new AggregateError(
						failures,
						'Browser runtime owner disposal failed',
					);
				}
			},
		};
	} catch (cause) {
		await physical?.dispose();
		throw cause;
	}
}

export type BrowserRuntimeOwner = Awaited<
	ReturnType<typeof openBrowserRuntimeOwner>
>;

import type {
	FirstAttachmentChoice,
	RecordEpicenter,
	RecordSyncStatus,
	RowDocument,
} from '@epicenter/data/record';
import type { connectRecordDocument } from '@epicenter/document-sync';
import { type HoneycrispData, honeycrispLens } from '@epicenter/honeycrisp';
import { createHoneycrispState } from '../routes/state/index.js';
import type { HoneycrispReplicaIdentityState } from './workspace/browser.js';

type ApplicationRuntime = {
	epicenter: Pick<
		RecordEpicenter<Blob, Blob>,
		| 'bind'
		| 'attachment'
		| 'syncStatus'
		| 'subscribeAttachment'
		| 'subscribeSyncStatus'
	>;
	readonly identity: HoneycrispReplicaIdentityState;
	subscribeIdentity(
		listener: (state: HoneycrispReplicaIdentityState) => void,
	): () => void;
	chooseFirstAttachment(choice: FirstAttachmentChoice): Promise<void>;
	connectDocument(
		document: RowDocument,
	): ReturnType<typeof connectRecordDocument>;
	[Symbol.asyncDispose](): Promise<void>;
};

export type HoneycrispDependencies = {
	openEpicenter(): Promise<ApplicationRuntime>;
	reportBackgroundError(cause: unknown): void;
};

export type HoneycrispNoteDocument = {
	document: RowDocument;
	connection: ReturnType<typeof connectRecordDocument>;
	[Symbol.asyncDispose](): Promise<void>;
};

export type HoneycrispApplication = HoneycrispData & {
	state: ReturnType<typeof createHoneycrispState>;
	readonly identity: HoneycrispReplicaIdentityState;
	readonly attachment: RecordEpicenter<Blob, Blob>['attachment'];
	readonly syncStatus: RecordSyncStatus;
	subscribeAttachment(
		listener: (attachment: RecordEpicenter<Blob, Blob>['attachment']) => void,
	): () => void;
	subscribeSyncStatus(listener: (status: RecordSyncStatus) => void): () => void;
	subscribeIdentity(
		listener: (state: HoneycrispReplicaIdentityState) => void,
	): () => void;
	chooseFirstAttachment(choice: FirstAttachmentChoice): Promise<void>;
	openNoteDocument(noteId: string): Promise<HoneycrispNoteDocument>;
	[Symbol.asyncDispose](): Promise<void>;
};

/** Open one fully acquired and hydrated Honeycrisp application. */
export async function openHoneycrispApplication(
	{ openEpicenter, reportBackgroundError }: HoneycrispDependencies,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<HoneycrispApplication> {
	let runtime: ApplicationRuntime | undefined;
	let state: ReturnType<typeof createHoneycrispState> | undefined;
	const documents = new Set<HoneycrispNoteDocument>();
	let releasePromise: Promise<void> | undefined;
	const release = (): Promise<void> => {
		releasePromise ??= (async () => {
			signal?.removeEventListener('abort', onAbort);
			const failures: unknown[] = [];
			for (const document of documents) {
				try {
					await document[Symbol.asyncDispose]();
				} catch (cause) {
					failures.push(cause);
				}
			}
			documents.clear();
			try {
				state?.[Symbol.dispose]();
			} catch (cause) {
				failures.push(cause);
			}
			try {
				await runtime?.[Symbol.asyncDispose]();
			} catch (cause) {
				failures.push(cause);
			}
			if (failures.length > 0) {
				throw new AggregateError(
					failures,
					'Honeycrisp application cleanup failed',
				);
			}
		})();
		return releasePromise;
	};
	const aborted = Promise.withResolvers<never>();
	const onAbort = () => {
		aborted.reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
		void release().catch(reportBackgroundError);
	};
	signal?.addEventListener('abort', onAbort, { once: true });
	const untilAbort = <TValue>(work: Promise<TValue>): Promise<TValue> =>
		signal ? Promise.race([work, aborted.promise]) : work;

	try {
		signal?.throwIfAborted();
		runtime = await untilAbort(openEpicenter());
		signal?.throwIfAborted();
		const activeRuntime = runtime;
		if (activeRuntime.identity.kind === 'principal-mismatch') {
			throw new Error(
				`These local notes belong to principal '${activeRuntime.identity.attachedPrincipalId}', not the signed-in principal '${activeRuntime.identity.signedInPrincipalId}'. Sign back into the original account or reset this site's local data.`,
			);
		}
		const data = activeRuntime.epicenter.bind({
			honeycrisp: honeycrispLens,
		}).honeycrisp;
		state = createHoneycrispState({
			honeycrisp: data,
			reportBackgroundError,
		});
		await untilAbort(state.whenReady);
		signal?.throwIfAborted();
		return Object.freeze({
			...data,
			state,
			get identity() {
				return activeRuntime.identity;
			},
			get attachment() {
				return activeRuntime.epicenter.attachment;
			},
			get syncStatus() {
				return activeRuntime.epicenter.syncStatus;
			},
			subscribeAttachment(
				listener: (
					attachment: RecordEpicenter<Blob, Blob>['attachment'],
				) => void,
			) {
				return activeRuntime.epicenter.subscribeAttachment(listener);
			},
			subscribeSyncStatus(listener: (status: RecordSyncStatus) => void) {
				return activeRuntime.epicenter.subscribeSyncStatus(listener);
			},
			subscribeIdentity(
				listener: (state: HoneycrispReplicaIdentityState) => void,
			) {
				return activeRuntime.subscribeIdentity(listener);
			},
			chooseFirstAttachment(choice: FirstAttachmentChoice) {
				return activeRuntime.chooseFirstAttachment(choice);
			},
			async openNoteDocument(noteId: string) {
				const document = await data.notes.openDocument(noteId);
				let connection: ReturnType<typeof connectRecordDocument>;
				try {
					connection = activeRuntime.connectDocument(document);
				} catch (cause) {
					await document[Symbol.asyncDispose]();
					throw cause;
				}
				let disposed = false;
				const opened: HoneycrispNoteDocument = {
					document,
					connection,
					async [Symbol.asyncDispose]() {
						if (disposed) return;
						disposed = true;
						documents.delete(opened);
						connection.dispose();
						await document[Symbol.asyncDispose]();
					},
				};
				documents.add(opened);
				return opened;
			},
			[Symbol.asyncDispose]: release,
		});
	} catch (cause) {
		try {
			await release();
		} catch (releaseCause) {
			throw new AggregateError(
				[cause, releaseCause],
				'Honeycrisp application acquisition and cleanup failed',
			);
		}
		throw cause;
	}
}

import type {
	EpicenterRuntime,
	RowDocument,
	SyncStatus,
} from '@epicenter/data/runtime';
import { honeycrispLens, type NoteId } from '@epicenter/honeycrisp';
import { createHoneycrispState } from '../routes/state/index.js';

export type HoneycrispDependencies = {
	openEpicenter(): Promise<EpicenterRuntime<Blob, Blob>>;
	reportBackgroundError(cause: unknown): void;
};

export type HoneycrispApplication = Awaited<
	ReturnType<typeof openHoneycrispApplication>
>;

/** Open one fully acquired and hydrated Honeycrisp application. */
export async function openHoneycrispApplication(
	{ openEpicenter, reportBackgroundError }: HoneycrispDependencies,
	{ signal }: { signal?: AbortSignal } = {},
) {
	let runtime: EpicenterRuntime<Blob, Blob> | undefined;
	let state: ReturnType<typeof createHoneycrispState> | undefined;
	let releasePromise: Promise<void> | undefined;
	const release = (): Promise<void> => {
		releasePromise ??= (async () => {
			signal?.removeEventListener('abort', onAbort);
			const failures: unknown[] = [];
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
		const data = activeRuntime.bind(honeycrispLens);
		state = createHoneycrispState({
			honeycrisp: data,
			reportBackgroundError,
		});
		await untilAbort(state.whenReady);
		signal?.throwIfAborted();
		return Object.freeze({
			...data,
			state,
			get syncStatus(): SyncStatus {
				return activeRuntime.sync.status;
			},
			subscribeSyncStatus(listener: (status: SyncStatus) => void) {
				return activeRuntime.sync.subscribe(listener);
			},
			/**
			 * Open one note's runtime-owned document. The runtime owns hydration,
			 * durability, realtime synchronization, reconnection, and revocation;
			 * the caller owns only this handle's disposal.
			 */
			async openNoteDocument(noteId: NoteId): Promise<RowDocument> {
				const { data: document, error } = await data.notes
					.record(noteId)
					.document.open();
				if (error !== null) throw error;
				return document;
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

/**
 * What a store refuses with, and what it throws when refusing is not on offer.
 *
 * Split out of `store.ts` because it is all declaration and no engine: a reader
 * asking what a `TableHandle` is used to scroll past a hundred and eighty lines
 * of error variants to reach it.
 *
 * Two channels, and the split is deliberate. `StoreError` is an outcome a
 * caller composes on; `StoreUnusableError` is thrown, because using a disposed
 * store is a programmer error rather than a result.
 */
import type { ConformanceIssue, JsonObject } from '@epicenter/app/definition';
import { LibraryClaimError } from '@epicenter/device/library-claim';
import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * The store capability itself is gone: the store was disposed.
 *
 * Thrown, never returned, and that is the boundary this type exists to hold
 * (ADR-0237). Every verb's `Result` carries outcomes the caller can act on at
 * that call site: a row that does not conform, or an address that holds no
 * row. Use-after-dispose is none of those; it is a
 * programmer error, and it surfaces at the application's error boundary,
 * once.
 *
 * Storage trouble is deliberately NOT here. A store whose durable writes fall
 * behind keeps serving the live document and reports through
 * `store.persistence` (ADR-0238); the poison that once lived in this class is
 * withdrawn.
 */
export class StoreUnusableError extends Error {
	override readonly name = 'StoreUnusableError';

	constructor() {
		super('This store is disposed');
	}
}

/**
 * A live stored value this release's declaration cannot fully read: what was
 * stored, what did conform, and what failed, so the call site composes its own
 * recovery.
 *
 * Plain diagnostic data, deliberately not a tagged error with a message. It is
 * the entire error arm of a read's `Result`, so there is nothing to
 * discriminate it from; it is about the relationship between one stored value
 * and one release-local declaration, never about the store failing
 * (ADR-0125). `raw` is the stored payload unmodified, including keys this
 * release cannot interpret. Never repaired and never hidden.
 */
export type NonconformingValue = {
	readonly raw: JsonObject;
	/** The fields that did pass, which is what recovery is composed from. */
	readonly conforming: JsonObject;
	readonly issues: readonly ConformanceIssue[];
};

/**
 * A live row this release's declaration cannot fully read.
 *
 * `conforming` carries the structural id, so the two branches of the one
 * recovery composition produce the same shape:
 * `data ?? { ...applicationRecovery, ...error.conforming }` is a whole row
 * either way. The id is not a declared field and cannot fail.
 */
export type NonconformingRow = NonconformingValue & {
	/** The structural row id, which is also the address that reported it. */
	readonly id: string;
};

export const StoreError = {
	...LibraryClaimError,
	...defineErrors({
		ClosedWhileOpening: () => ({
			message: 'The store was closed while it was opening.',
		}),
		/**
		 * A write named an address that holds no row.
		 *
		 * The verb this replaces returned `Ok(undefined)` and silently swallowed the
		 * write, which is a live bug in the code this store supersedes. A write that
		 * reaches nothing is a failure and says so.
		 */
		RowAbsent: ({ table, rowId }: { table: string; rowId: string }) => ({
			message: `Table '${table}' holds no row '${rowId}'`,
			table,
			rowId,
		}),
		/**
		 * Opening could not reach or seed durable storage.
		 *
		 * A boot outcome, which is why it is returned rather than thrown: an opener
		 * is fallible I/O and its caller renders a boot failure. A store that
		 * cannot READ its durable record has nothing trustworthy to hydrate from.
		 * Once a store is open, storage never fails a verb again: durable writes
		 * are a visible, retryable debt reported through `store.persistence`
		 * (ADR-0238).
		 */
		StorageFailed: ({ cause }: { cause: unknown }) => ({
			message: 'The store could not commit to durable storage',
			cause,
		}),
		/**
		 * Foreign bytes arrived that this document cannot decode.
		 *
		 * A property of the bytes, not of the store: nothing was persisted and the
		 * store is still usable. The transport treats the position as a poison pill
		 * and says so loudly rather than advancing past it.
		 */
		ApplyFailed: ({ cause }: { cause: unknown }) => ({
			message: 'These bytes could not be applied to this document',
			cause,
		}),
		/** An application or remote identity cannot be represented in a durable address. */
		Unaddressable: ({ reason }: { reason: string }) => ({
			message: `This database cannot be named: ${reason}`,
			reason,
		}),
		/**
		 * A subscriber threw while being told about a committed change.
		 *
		 * Logged, never returned. It is the subscriber's own bug, the commit that
		 * produced the notification is already durable, and failing the write that
		 * caused it would make one broken listener into everybody's data loss.
		 */
		SubscriberThrew: ({ cause }: { cause: unknown }) => ({
			message: 'A store subscriber threw while being told about a commit',
			cause,
		}),
	}),
};
export type StoreError = InferErrors<typeof StoreError>;

export type RowAbsentError = Extract<StoreError, { name: 'RowAbsent' }>;
export type ApplyFailedError = Extract<StoreError, { name: 'ApplyFailed' }>;

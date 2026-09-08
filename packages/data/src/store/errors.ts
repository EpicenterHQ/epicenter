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
import type { ConformanceIssue, JsonObject } from '@epicenter/data/definition';
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

export const StoreError = defineErrors({
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
	/**
	 * Another context holds this document's address open, and it is still
	 * holding it.
	 *
	 * A second open would be a second `Y.Doc` over one document, and the two
	 * cannot see each other's writes: they converge through storage under
	 * last-writer-wins, so one side's work vanishes with no error and nothing to
	 * retry (ADR-0229). Close the other window, or share the one you have.
	 *
	 * **A CONFIRMED ownership conflict and nothing else.** This used to be the
	 * answer to four unrelated situations, of which three were not conflicts:
	 * a runtime with no Web Locks (`LocksUnsupported`), a lock request that
	 * threw (`ClaimFailed`), and an address that already holds state
	 * (`GenerationExists`). An application's boot node tells a person to close
	 * another window when it sees this name, so a name that can mean four
	 * things tells three quarters of the people who reach it to do something
	 * that cannot help.
	 */
	AlreadyOpen: ({ address }: { address: string }) => ({
		message: `Another context already has ${address} open`,
		address,
	}),
	/**
	 * This runtime ships no Web Locks API, so a single owner cannot be proven.
	 *
	 * Refused rather than opened unguarded, which is the corruption `claims.ts`
	 * exists to prevent arriving quietly on whatever runtime happens to lack
	 * the API. Every browser this store targets ships it, and a WebKitGTK older
	 * than 2.36 is the live case: there is no repair a person can perform in
	 * the page, which is exactly why it must not wear `AlreadyOpen`'s clothes
	 * and ask them to close a window they do not have open.
	 */
	LocksUnsupported: ({ address }: { address: string }) => ({
		message: `This runtime cannot claim ${address}: it has no Web Locks`,
		address,
	}),
	/**
	 * The lock request itself failed, which says nothing about who holds it.
	 *
	 * Distinct from `AlreadyOpen` because the cause is unknown: reporting a
	 * mechanism failure as a conflict names a repair that may be irrelevant. A
	 * retry is the honest answer, and the `cause` is what a bug report carries.
	 */
	ClaimFailed: ({ address, cause }: { address: string; cause: unknown }) => ({
		message: `The claim on ${address} could not be requested`,
		address,
		cause,
	}),
	/**
	 * This device already holds state at that generation's address.
	 *
	 * A generation is created once and never mutated in place, so a write that
	 * meets bytes is a caller confusing import with sync (ADR-0293). It is not
	 * an ownership conflict: nobody holds the document open, and closing a
	 * window changes nothing.
	 */
	GenerationExists: ({
		dataId,
		generation,
	}: {
		dataId: string;
		generation: number;
	}) => ({
		message: `This device already holds generation ${generation} of '${dataId}'`,
		dataId,
		generation,
	}),
	/**
	 * The store was asked for something it cannot name.
	 *
	 * Three inputs reach this, and they are one refusal because they are one
	 * sentence: an application id, a principal id, or a generation number that
	 * cannot be a segment of an address. Guessing any of them would open bytes
	 * that belong to something else, or take edits into a record nothing can
	 * claim afterwards.
	 *
	 * A signed-out account states no principal, which is the live path here:
	 * `@epicenter/app` hands the opener the account it has and lets this refuse
	 * it rather than guessing one. Conflating that with `GenerationNotFound`
	 * would tell a person their data is missing when nothing was ever asked
	 * for.
	 */
	Unaddressable: ({ reason }: { reason: string }) => ({
		message: `This database cannot be named: ${reason}`,
		reason,
	}),
	/**
	 * This device holds no copy of the generation asked for, and has no account
	 * to fetch it from (ADR-0292).
	 *
	 * A generation number is an ADDRESS, not an instruction to allocate. Opening
	 * an empty database here would turn any URL somebody typed into a real
	 * generation, so the miss is reported and the caller decides: import a
	 * folder to create one, or send the person somewhere that exists.
	 */
	GenerationNotFound: ({
		dataId,
		generation,
	}: {
		dataId: string;
		generation: number;
	}) => ({
		message: `This device holds no generation ${generation} of '${dataId}'`,
		dataId,
		generation,
	}),
	/**
	 * The authority could not be reached for a generation this device lacks.
	 *
	 * Distinct from `GenerationNotFound`, and the distinction is the whole
	 * point: not-found is a fact about the generation and this is a fact about
	 * the network. A retry can fix one and never the other, so a boot surface
	 * that conflates them tells a person their data is gone when their wifi is
	 * off.
	 */
	GenerationUnreachable: ({
		dataId,
		generation,
		status,
		cause,
	}: {
		dataId: string;
		generation: number;
		status?: number;
		cause?: unknown;
	}) => ({
		message: `Generation ${generation} of '${dataId}' could not be fetched${
			status === undefined ? '' : ` (${status})`
		}`,
		dataId,
		generation,
		status,
		cause,
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
});
export type StoreError = InferErrors<typeof StoreError>;

export type RowAbsentError = Extract<StoreError, { name: 'RowAbsent' }>;
export type ApplyFailedError = Extract<StoreError, { name: 'ApplyFailed' }>;

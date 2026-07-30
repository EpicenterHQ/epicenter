/**
 * @fileoverview What a bound handle reports when its data may be stale.
 *
 * One rule decides the shape of everything here: a bound handle reports when
 * data reachable *through it* may be stale. A table handle can sometimes name
 * the rows that moved, because a row has a runtime id the replica already
 * emitted. A value handle cannot, because a value has no smaller identity than
 * itself: there is nothing left to name once you have named the handle.
 *
 * That asymmetry is honest rather than tidy. Two shapes for two unlike things
 * beats one shape that lies about one of them.
 *
 * # The laws
 *
 * 1. **Invalidation is a superset.** It may over-report and must never
 *    under-report. Every consumer downstream is allowed to re-read more than it
 *    strictly had to; none is allowed to miss a change.
 * 2. **Registration is synchronous, does no I/O, and never fires initially.** A
 *    caller that subscribes and then reads has already seen everything: the
 *    subscription was installed before the read started.
 * 3. **One invalidation per committed replica notification per logical table.**
 *    A commit that touches sixty-four rows of one table calls a listener once
 *    with sixty-four ids, not sixty-four times.
 * 4. **Delivery may duplicate.** Consumers converge idempotently.
 * 5. **A table-scope invalidation supersedes in-flight incremental work.** It
 *    says "everything reachable here may be stale", which is strictly stronger
 *    than any set of row ids still being processed.
 * 6. **A carrier gap heals locally.** When an observation carrier reconnects,
 *    the client emits table scope to every subscribed table and a void
 *    invalidation to every subscribed value. Nothing on the wire encodes
 *    reconnection, reset, or scope; the client that noticed the gap is the one
 *    that knows which handles were listening across it.
 *
 * Law 6 is why `scope: 'table'` exists at all. Without it the only honest
 * response to a gap would be to fail the handle closed and make the app reload,
 * because a deletion that happened while the socket was down cannot be
 * enumerated: the row is gone, so there is nothing left to name it with.
 */

import { defineErrors, extractErrorMessage } from 'wellcrafted/error';

import { type Address, addressKey, type ValueAddress } from './addresses.js';

/**
 * What a table handle reports when rows reachable through it may be stale.
 *
 * `rows` names exactly the row ids that a commit touched. `table` says the
 * handle cannot name them, so everything reachable through it may have moved.
 * Both arms are objects with a `scope` discriminant on purpose: the rejected
 * `readonly string[] | 'all'` compiles when a caller forgets to narrow, and
 * then iterates `'all'` as the three row ids `a`, `l`, `l`.
 *
 * `rowIds` is an ordinary `readonly string[]`. The runtime never emits an empty
 * one, but a non-empty tuple type in the public surface would make every caller
 * carry a constraint that only the producer can violate.
 */
export type TableInvalidation =
	| { readonly scope: 'rows'; readonly rowIds: readonly string[] }
	| { readonly scope: 'table' };

export type TableInvalidationListener = (
	invalidation: TableInvalidation,
) => void;
export type ValueInvalidationListener = () => void;

const ObservationError = defineErrors({
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: `Data subscriber threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

/**
 * A private, order-stable key for one logical table.
 *
 * One Epicenter can bind several Lenses, so a registry keyed by local table
 * name alone would cross namespaces and deliver one app's invalidations to
 * another's handle.
 */
function tableKey(namespace: string, tableName: string): string {
	return `${JSON.stringify(namespace)}:${JSON.stringify(tableName)}`;
}

/**
 * Where a contained subscriber failure goes.
 *
 * Structurally the one method this needs rather than `wellcrafted/logger`'s
 * `Logger`, and deliberately so. This package's declarations are compiled and
 * published, so every type they name is type-checked inside a stranger's
 * project against their `lib` and their dependency versions. `Logger` reaches
 * `AsyncDisposable`, which a consumer targeting ES2022 does not have, and a
 * vocabulary package has no business dictating anyone's logging stack. A
 * `wellcrafted` logger satisfies this shape, so callers that already have one
 * pass it unchanged.
 */
export type InvalidationErrorReporter = {
	error(error: unknown): void;
};

/**
 * The one place a batch of committed addresses becomes per-handle
 * invalidations.
 *
 * Every client owns one of these: the in-process runtime, the browser page
 * proxy, and the desktop surface proxy. They differ in where the addresses come
 * from (a replica subscription, a worker message, a host socket frame) and in
 * nothing else, so the grouping law, the delivery law, and gap recovery are
 * written once here rather than three times with three chances to drift.
 *
 * It holds listeners and nothing else. It reads no data, performs no I/O, and
 * cannot answer what a row now contains: a consumer that wants to know re-reads
 * through the handle it already has.
 */
export function createInvalidationDispatcher({
	log = { error: () => undefined },
}: {
	log?: InvalidationErrorReporter;
} = {}) {
	const tableListeners = new Map<string, Set<TableInvalidationListener>>();
	const valueListeners = new Map<string, Set<ValueInvalidationListener>>();

	/**
	 * A subscriber that throws is contained rather than allowed to abort the
	 * batch. One handle's broken listener must not cost every other handle its
	 * invalidation, and the commit that produced the batch is already durable.
	 */
	function callTableListener(
		listener: TableInvalidationListener,
		invalidation: TableInvalidation,
	): void {
		try {
			listener(invalidation);
		} catch (cause) {
			log.error(ObservationError.SubscriberThrew({ cause }));
		}
	}

	function callValueListener(listener: ValueInvalidationListener): void {
		try {
			listener();
		} catch (cause) {
			log.error(ObservationError.SubscriberThrew({ cause }));
		}
	}

	return {
		subscribeTable(
			namespace: string,
			tableName: string,
			listener: TableInvalidationListener,
		): () => void {
			const key = tableKey(namespace, tableName);
			const listeners = tableListeners.get(key) ?? new Set();
			listeners.add(listener);
			tableListeners.set(key, listeners);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) tableListeners.delete(key);
			};
		},

		subscribeValue(
			address: ValueAddress,
			listener: ValueInvalidationListener,
		): () => void {
			const key = addressKey(address);
			const listeners = valueListeners.get(key) ?? new Set();
			listeners.add(listener);
			valueListeners.set(key, listeners);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) valueListeners.delete(key);
			};
		},

		/**
		 * Deliver one committed batch of addresses.
		 *
		 * Grouping happens before any listener runs, so a commit touching many
		 * rows of one table produces one call carrying every id rather than one
		 * call per row. Row ids are deduplicated within a table, because the same
		 * address can appear twice in one batch and a consumer that point-reads
		 * should not read it twice.
		 */
		deliver(addresses: readonly Address[]): void {
			if (addresses.length === 0) return;
			const rowsByTable = new Map<string, Set<string>>();
			const values = new Set<string>();
			for (const address of addresses) {
				if (address.kind === 'value') {
					values.add(addressKey(address));
					continue;
				}
				const key = tableKey(address.namespace, address.tableName);
				const ids = rowsByTable.get(key) ?? new Set<string>();
				ids.add(address.rowId);
				rowsByTable.set(key, ids);
			}
			for (const [key, ids] of rowsByTable) {
				const listeners = tableListeners.get(key);
				if (listeners === undefined) continue;
				const invalidation: TableInvalidation = {
					scope: 'rows',
					rowIds: [...ids],
				};
				for (const listener of [...listeners]) {
					callTableListener(listener, invalidation);
				}
			}
			for (const key of values) {
				const listeners = valueListeners.get(key);
				if (listeners === undefined) continue;
				for (const listener of [...listeners]) callValueListener(listener);
			}
		},

		/**
		 * Heal an observation gap.
		 *
		 * Every subscribed table hears table scope and every subscribed value
		 * hears its void invalidation. This is the whole of law 6: the carrier
		 * says only that it reconnected, and the client that was holding the
		 * subscriptions turns that into the strongest honest statement it can
		 * make about each one.
		 */
		invalidateAll(): void {
			const tableScope: TableInvalidation = { scope: 'table' };
			for (const listeners of [...tableListeners.values()]) {
				for (const listener of [...listeners]) {
					callTableListener(listener, tableScope);
				}
			}
			for (const listeners of [...valueListeners.values()]) {
				for (const listener of [...listeners]) callValueListener(listener);
			}
		},

		clear(): void {
			tableListeners.clear();
			valueListeners.clear();
		},
	};
}

export type InvalidationDispatcher = ReturnType<
	typeof createInvalidationDispatcher
>;

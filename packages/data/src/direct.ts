/**
 * Open a store DIRECTLY, over a synchronous SQLite the caller opened itself.
 *
 * Named for what it does rather than for a layer. It was `@epicenter/data/direct`
 * and there is no engine here: `syncEngineOf` is one accessor and the rest is a
 * opener, while the actual engine lives in `store/store.ts` where nothing
 * calls itself one.
 *
 * Not the public story. An application opens its data through a runtime's
 * opener (`@epicenter/data/browser`), which owns the address, the claim, the
 * format enforcement, and deletion. This entry point exists for runtimes that
 * have no named opener: today that is exclusively test infrastructure inside
 * `workerd`, where the only synchronous SQLite is a Durable Object's own
 * storage (the sync-lab peer, the server store probe), the in-package
 * benches, and a test that needs two releases over one durable record. If a
 * production runtime ever needs to open a store this way, that is the moment
 * it earns a named opener beside the others, not a reason to reach here.
 *
 * Account stores only. A local store declares `replication: 'none'`, and every
 * runtime that reaches this seam is a sync peer, so there has never been a
 * caller for one and there is no shape of caller that would want it.
 */
export {
	type CreateStoreOptions,
	openAccountStore,
	syncEngineOf,
} from './store/store.js';

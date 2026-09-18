/**
 * Explicit SQLite-backed account stores for Worker probes and store tests.
 * The caller owns the SQLite adapter. Applications open through defineApp().open().
 */
export {
	type CreateStoreOptions,
	openAccountStore,
	syncEngineOf,
} from './store/store.js';

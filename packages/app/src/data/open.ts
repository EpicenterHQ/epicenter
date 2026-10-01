import type { SqliteDatabase } from '@epicenter/sqlite';
import type { DataDefinition } from './definition/declaration.js';
import { openAccountStore } from './store/store.js';

/** Open data over caller-owned SQLite. Disposing the data drains writes but never closes the supplied database. */
export function openData<const TDefinition extends DataDefinition>(
	definition: TDefinition,
	sqlite: SqliteDatabase,
) {
	return openAccountStore({ definition, sqlite });
}
export { syncEngineOf } from './store/store.js';

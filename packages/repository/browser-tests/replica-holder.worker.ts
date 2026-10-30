/**
 * A worker that holds a replica's database and does nothing else, as the
 * worker of a frozen tab would: the tests use it to keep the storage busy
 * while another tab takes the replica.
 */
import { openReplicaDatabase } from '../src/hosts/browser/sqlite.js';
import type { SqlDriver } from '../src/sql.js';

let driver: SqlDriver | null = null;
addEventListener(
	'message',
	async (
		event: MessageEvent<
			{ type: 'hold'; replica: string } | { type: 'release' }
		>,
	) => {
		if (event.data.type === 'hold') {
			const opened = await openReplicaDatabase(event.data.replica);
			if (opened.error !== null) throw new Error(opened.error.message);
			driver = opened.data;
			postMessage('held');
			return;
		}
		driver?.close();
		driver = null;
		postMessage('released');
	},
);

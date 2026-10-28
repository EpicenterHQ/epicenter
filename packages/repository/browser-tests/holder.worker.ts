/**
 * A worker that holds a repository's database and does nothing else, as the
 * worker of a frozen tab would: the tests use it to keep the storage busy
 * while another tab takes the repository.
 */
import { openOpfsDatabase } from '../src/browser/sqlite.js';
import type { SqlDriver } from '../src/sql.js';

let driver: SqlDriver | null = null;
addEventListener('message', async (event: MessageEvent<{ type: 'hold'; name: string } | { type: 'release' }>) => {
	if (event.data.type === 'hold') {
		const opened = await openOpfsDatabase(event.data.name);
		if (opened.error !== null) throw new Error(opened.error.message);
		driver = opened.data;
		postMessage('held');
		return;
	}
	driver?.close();
	driver = null;
	postMessage('released');
});

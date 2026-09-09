import { Database } from 'bun:sqlite';
import { createSelfHostAuth } from './index.js';

/** Open the same auth commits on Bun's durable SQLite database. */
export function openSelfHostAuth({
	path,
	origin,
	callbacks,
}: {
	path: string;
	origin: string;
	callbacks: readonly string[];
}) {
	const sqlite = new Database(path, { create: true });
	sqlite.exec('PRAGMA journal_mode = WAL');
	sqlite.exec('PRAGMA busy_timeout = 5000');
	const auth = createSelfHostAuth({
		origin,
		callbacks,
		database: {
			all<T>(sql: string, ...bindings: (string | number | null)[]) {
				return sqlite.query(sql).all(...bindings) as T[];
			},
			run(sql, ...bindings) {
				sqlite.query(sql).run(...bindings);
			},
			transaction(operation) {
				return sqlite.transaction(operation).immediate();
			},
		},
	});
	return {
		auth,
		close() {
			sqlite.close();
		},
	};
}

/** Test-only durable state machine. Not a server export or production protocol. */
import { Database } from 'bun:sqlite';

export function openInitialization(ledgerPath: string, authorityPath: string) {
	const ledger = new Database(ledgerPath, { create: true });
	const authority = new Database(authorityPath, { create: true });
	ledger.exec(`CREATE TABLE IF NOT EXISTS generations (n INTEGER PRIMARY KEY, admitted INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE IF NOT EXISTS initial (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), n INTEGER NOT NULL);`);
	authority.exec(
		'CREATE TABLE IF NOT EXISTS snapshots (n INTEGER PRIMARY KEY, bytes BLOB NOT NULL CHECK(length(bytes) > 0))',
	);
	const list = () =>
		ledger
			.query<{ n: number }, []>(
				'SELECT n FROM generations WHERE admitted = 1 ORDER BY n',
			)
			.all()
			.map((row) => row.n);
	const allocate = () => {
		const n = ledger
			.query<{ n: number }, []>(
				'SELECT COALESCE(MAX(n), 0) + 1 AS n FROM generations',
			)
			.get()!.n;
		ledger.query('INSERT INTO generations (n) VALUES (?)').run(n);
		return n;
	};
	const reserve = ledger.transaction(() => {
		const existing = ledger
			.query<{ n: number }, []>('SELECT n FROM initial')
			.get();
		if (existing) return existing.n;
		const n = list().at(-1) ?? allocate();
		ledger.query('INSERT INTO initial VALUES (1, ?)').run(n);
		return n;
	});
	return {
		list,
		reserve,
		/** Separate authority transaction: first complete write wins; retries never overwrite. */
		initialize(n: number, bytes: Uint8Array) {
			if (bytes.byteLength === 0)
				throw new Error('A snapshot must contain bytes');
			authority
				.query('INSERT OR IGNORE INTO snapshots VALUES (?, ?)')
				.run(n, bytes);
		},
		/** Internal coordinator only. A public client never supplies proof of storage. */
		admit(n: number) {
			if (!authority.query('SELECT n FROM snapshots WHERE n = ?').get(n))
				throw new Error('Snapshot missing');
			ledger.query('UPDATE generations SET admitted = 1 WHERE n = ?').run(n);
		},
		read(n: number) {
			if (!list().includes(n)) return undefined;
			return authority
				.query<{ bytes: Uint8Array }, [number]>(
					'SELECT bytes FROM snapshots WHERE n = ?',
				)
				.get(n)?.bytes;
		},
		/** Explicit imports allocate independently and do not replace the initial selection. */
		allocateImport: ledger.transaction(allocate),
		close() {
			authority.close();
			ledger.close();
		},
	};
}

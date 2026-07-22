import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const FORMAT_VERSION = 1;
const LIFETIME =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL_SCHEMA = `CREATE TABLE active_authority (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	format_version INTEGER NOT NULL CHECK (format_version = 1),
	authority_lifetime TEXT NOT NULL UNIQUE
) STRICT`;

type ActiveRow = {
	format_version: number;
	authority_lifetime: string;
};

type TableColumn = {
	name: string;
	type: string;
	notnull: number;
	pk: number;
	hidden: number;
};

function requireLifetime(value: string): void {
	if (!LIFETIME.test(value)) {
		throw new Error('Bun authority lifetime must be a lowercase UUID');
	}
}

/** Durable host pointer whose transaction commit is Bun Restore activation. */
export function openBunAuthorityControlV1(directory: string) {
	mkdirSync(directory, { recursive: true });
	const raw = new Database(join(directory, 'control-v1.sqlite'), {
		create: true,
		strict: true,
	});
	raw.run('PRAGMA busy_timeout = 0');
	try {
		raw.run('PRAGMA journal_mode = WAL');
		raw.run('PRAGMA synchronous = FULL');
	} catch (cause) {
		raw.close();
		throw cause;
	}
	const objects = raw
		.query<{ name: string; type: string; sql: string }, []>(
			`SELECT name, type, sql FROM sqlite_schema
			WHERE name NOT LIKE 'sqlite_%'
			ORDER BY type, name`,
		)
		.all();
	if (objects.length === 0) {
		raw.transaction(() => {
			raw.run(CONTROL_SCHEMA);
		})();
	} else if (
		objects.length !== 1 ||
		objects[0]?.type !== 'table' ||
		objects[0].name !== 'active_authority' ||
		objects[0].sql !== CONTROL_SCHEMA
	) {
		raw.close();
		throw new Error('Bun authority control schema is not recognized');
	}
	const table = raw
		.query<{ name: string; wr: number; strict: number }, []>(
			`PRAGMA table_list('active_authority')`,
		)
		.all();
	const columns = raw
		.query<TableColumn, []>(`PRAGMA table_xinfo('active_authority')`)
		.all();
	const expectedColumns = [
		['singleton', 'INTEGER', 0, 1, 0],
		['format_version', 'INTEGER', 1, 0, 0],
		['authority_lifetime', 'TEXT', 1, 0, 0],
	] as const;
	if (
		table.length !== 1 ||
		table[0]?.name !== 'active_authority' ||
		table[0].strict !== 1 ||
		table[0].wr !== 0 ||
		columns.length !== expectedColumns.length ||
		columns.some((column, index) => {
			const expected = expectedColumns[index];
			return (
				expected === undefined ||
				column.name !== expected[0] ||
				column.type !== expected[1] ||
				column.notnull !== expected[2] ||
				column.pk !== expected[3] ||
				column.hidden !== expected[4]
			);
		})
	) {
		raw.close();
		throw new Error('Bun authority control table shape is not recognized');
	}

	function active(): string | undefined {
		const rows = raw
			.query<ActiveRow, []>(
				`SELECT format_version, authority_lifetime
				FROM active_authority WHERE singleton = 1`,
			)
			.all();
		if (rows.length === 0) return undefined;
		const row = rows[0];
		if (
			rows.length !== 1 ||
			row === undefined ||
			row.format_version !== FORMAT_VERSION
		) {
			throw new Error('Bun authority control metadata is not recognized');
		}
		requireLifetime(row.authority_lifetime);
		return row.authority_lifetime;
	}

	return Object.freeze({
		active,
		initialize(authorityLifetime: string): void {
			requireLifetime(authorityLifetime);
			raw.transaction(() => {
				if (active() !== undefined) {
					throw new Error('Bun authority control is already initialized');
				}
				raw.run(
					`INSERT INTO active_authority (
						singleton, format_version, authority_lifetime
					) VALUES (1, ?, ?)`,
					[FORMAT_VERSION, authorityLifetime],
				);
			})();
		},
		activate(expectedLifetime: string, successorLifetime: string) {
			requireLifetime(expectedLifetime);
			requireLifetime(successorLifetime);
			let casMiss = false;
			try {
				raw.transaction(() => {
					const result = raw
						.query<never, [string, string]>(
							`UPDATE active_authority SET authority_lifetime = ?
							WHERE singleton = 1 AND authority_lifetime = ?`,
						)
						.run(successorLifetime, expectedLifetime);
					if (result.changes !== 1) {
						casMiss = true;
						throw new Error(
							'Bun authority activation lost its compare-and-swap',
						);
					}
				})();
				return { kind: 'activated' } as const;
			} catch (cause) {
				if (casMiss) return { kind: 'unchanged', cause } as const;
				try {
					const selected = active();
					if (selected === successorLifetime) {
						return { kind: 'activated' } as const;
					}
					if (selected === expectedLifetime) {
						return { kind: 'unchanged', cause } as const;
					}
					return { kind: 'indeterminate', cause, selected } as const;
				} catch (proofCause) {
					return {
						kind: 'indeterminate',
						cause: new AggregateError(
							[cause, proofCause],
							'Bun authority activation and reconciliation failed',
						),
						selected: undefined,
					} as const;
				}
			}
		},
		close(): void {
			raw.close();
		},
	});
}

export type BunAuthorityControlV1 = ReturnType<
	typeof openBunAuthorityControlV1
>;

/** Hold exclusive ownership of one principal until the returned owner closes. */
export function acquireBunAuthorityOwnerV1(directory: string) {
	mkdirSync(directory, { recursive: true });
	const raw = new Database(join(directory, 'owner-v1.sqlite'), {
		create: true,
	});
	raw.run('PRAGMA busy_timeout = 0');
	try {
		raw.run('BEGIN EXCLUSIVE');
	} catch (cause) {
		raw.close();
		throw new Error('Bun authority principal is already owned', { cause });
	}
	let closed = false;
	return Object.freeze({
		close(): void {
			if (closed) return;
			closed = true;
			try {
				raw.run('ROLLBACK');
			} finally {
				raw.close();
			}
		},
	});
}

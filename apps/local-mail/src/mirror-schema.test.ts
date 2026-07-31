/**
 * The rebuild gate's inputs. What the fingerprint MUST notice: any change to
 * the stored column set, its types, or its `json_extract` projections, plus a
 * bumped derivation token for the columns imperative code fills. What it must
 * NOT notice: reformatting, key reordering, and index changes, because each of
 * those would cost a full mailbox re-download for no change in what a row
 * holds. The behavioural half of the gate (writer rebuilds, reader does not)
 * lives in `db.test.ts`.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
	canonicalizeDeclaration,
	fingerprintDeclaration,
} from './fingerprint.ts';
import { STORED_PROJECTIONS } from './message-fields.ts';
import {
	CREATE_INDEXES_SQL,
	CREATE_TABLES_SQL,
	MIRROR_DECLARATION,
	MIRROR_FINGERPRINT,
} from './mirror-schema.ts';

const DOMAIN = 'epicenter.local-mail.mirror/v1';

type DeclarationCopy = {
	tables: Record<
		string,
		{
			name: string;
			type: string;
			generated?: { expression: string; storage: string };
			derivation?: number;
		}[]
	>;
};

/** The declaration re-serialized through JSON, so a test can perturb one field
 * without mutating the module's own value. */
function declarationCopy(): DeclarationCopy {
	return JSON.parse(JSON.stringify(MIRROR_DECLARATION));
}

function column(declaration: DeclarationCopy, table: string, name: string) {
	const found = declaration.tables[table]?.find((c) => c.name === name);
	if (!found) throw new Error(`${table}.${name} is not declared`);
	return found;
}

describe('the mirror declaration', () => {
	test('is what the live fingerprint hashes', () => {
		expect(fingerprintDeclaration(DOMAIN, MIRROR_DECLARATION)).toBe(
			MIRROR_FINGERPRINT,
		);
		expect(MIRROR_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/);
	});

	test('survives reordering and reformatting unchanged', () => {
		// The same declaration written with its table keys the other way round.
		const { messages, labels } = MIRROR_DECLARATION.tables;
		const reordered = { tables: { labels, messages } };

		expect(canonicalizeDeclaration(reordered)).toBe(
			canonicalizeDeclaration(MIRROR_DECLARATION),
		);
		expect(fingerprintDeclaration(DOMAIN, reordered)).toBe(MIRROR_FINGERPRINT);
	});

	test('moves when the stored row shape changes', () => {
		const renamed = declarationCopy();
		column(renamed, 'messages', 'body_text').name = 'body';
		expect(fingerprintDeclaration(DOMAIN, renamed)).not.toBe(
			MIRROR_FINGERPRINT,
		);

		const retyped = declarationCopy();
		column(retyped, 'messages', 'internal_date').type = 'TEXT';
		expect(fingerprintDeclaration(DOMAIN, retyped)).not.toBe(
			MIRROR_FINGERPRINT,
		);

		const reprojected = declarationCopy();
		const snippet = column(reprojected, 'messages', 'snippet');
		expect(snippet.generated).toBeDefined();
		snippet.generated = {
			expression: `json_extract(raw, '$.preview')`,
			storage: 'STORED',
		};
		expect(fingerprintDeclaration(DOMAIN, reprojected)).not.toBe(
			MIRROR_FINGERPRINT,
		);

		const dropped = declarationCopy();
		dropped.tables.labels = dropped.tables.labels?.slice(0, -1) ?? [];
		expect(fingerprintDeclaration(DOMAIN, dropped)).not.toBe(
			MIRROR_FINGERPRINT,
		);
	});

	test('moves when any one derivation token is bumped', () => {
		// The three imperatively filled columns are exactly the ones a structural
		// declaration cannot watch, so each must move the fingerprint on its own.
		for (const name of ['subject', 'sender', 'body_text']) {
			const bumped = declarationCopy();
			const target = column(bumped, 'messages', name);
			expect(typeof target.derivation).toBe('number');
			target.derivation = (target.derivation ?? 0) + 1;
			expect(fingerprintDeclaration(DOMAIN, bumped)).not.toBe(
				MIRROR_FINGERPRINT,
			);
		}
	});

	test('carries a token for every stored projection and none for bodyHtml', () => {
		const withTokens = MIRROR_DECLARATION.tables.messages
			.filter((column) => column.derivation !== undefined)
			.map((column) => column.name);
		expect(withTokens).toEqual(['subject', 'sender', 'body_text']);
		// `bodyHtml` is derived from `raw` at read time and never stored, so it has
		// no column here and no token in `STORED_PROJECTIONS`.
		expect(Object.keys(STORED_PROJECTIONS)).toEqual([
			'subject',
			'sender',
			'bodyText',
		]);
	});

	test('keeps indexes out of the fingerprint', () => {
		// Indexes are real DDL the mirror runs, and they name declared columns...
		expect(CREATE_INDEXES_SQL).toContain('idx_messages_thread');
		expect(CREATE_INDEXES_SQL).toContain('internal_date');
		// ...but nothing in the hashed declaration mentions them, so adding or
		// dropping one cannot force a re-pull.
		expect(canonicalizeDeclaration(MIRROR_DECLARATION)).not.toContain('idx_');
		expect(canonicalizeDeclaration(MIRROR_DECLARATION)).not.toContain('INDEX');
	});
});

describe('the generated DDL', () => {
	test('builds the declared columns with the declared storage classes', () => {
		const db = new Database(':memory:');
		db.exec(CREATE_TABLES_SQL);
		db.exec(CREATE_INDEXES_SQL);

		for (const [table, columns] of Object.entries(MIRROR_DECLARATION.tables)) {
			// `table_xinfo` exposes generated columns (`hidden` 2 = VIRTUAL, 3 =
			// STORED) that plain `table_info` hides, which is what makes this a real
			// check that the declaration produced the physical shape.
			const actual = db
				.query<{ name: string; type: string; hidden: number }, []>(
					`PRAGMA table_xinfo(${table})`,
				)
				.all();
			expect(actual.map((column) => column.name)).toEqual(
				columns.map((column) => column.name),
			);
			for (const [index, declared] of columns.entries()) {
				const expectedHidden = !declared.generated
					? 0
					: declared.generated.storage === 'VIRTUAL'
						? 2
						: 3;
				expect({
					name: actual[index]?.name,
					hidden: actual[index]?.hidden,
				}).toEqual({ name: declared.name, hidden: expectedHidden });
			}
		}

		db.close();
	});
});

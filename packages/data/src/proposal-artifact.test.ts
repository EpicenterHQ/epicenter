/**
 * Proposal SQLite Artifact Tests
 *
 * Verifies that Proposal drafts keep sealed raw source data separate from
 * editable Lens tables and compile those edits into one authenticated manifest.
 *
 * Key behaviors:
 * - exact selections refuse missing, extra, and nonconforming source records
 * - edits compile to patches, tombstones, unsets, and collision-refusing creates
 * - schema, base, manifest, and mutable watermark tampering is refused
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Type } from 'typebox';

import { defineLens, defineTable, defineValues } from './lens.js';
import {
	advanceProposalWatermark,
	compileProposalArtifact,
	type ProposalSelection,
	type ProposalSourceRecord,
	readProposalManifest,
	writeProposalArtifact,
} from './proposal-artifact.js';
import { SCALAR_SYNC_V1_LIMITS } from './protocol/v1/index.js';

const HMAC_KEY = new Uint8Array(32).fill(7);
const NAMESPACE = 'so.epicenter.notes';
const NOTE_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const NOTE_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function proposalLens() {
	return defineLens({
		namespace: NAMESPACE,
		title: 'Notes',
		description: 'Notes and settings.',
		collections: {
			notes: defineTable({
				title: 'Notes',
				fields: {
					title: field.string(),
					done: field.boolean(),
					labels: field.tags(),
					metadata: field.json(
						Type.Union([Type.Object({ rank: Type.Number() }), Type.Null()]),
					),
				},
				optional: ['done', 'labels', 'metadata'],
			}),
			settings: defineValues({
				title: 'Settings',
				values: {
					theme: field.select(['light', 'dark']),
					filters: field.tags(),
				},
			}),
		},
	});
}

function proposalSelection(allowCreate = true): ProposalSelection {
	return {
		namespace: NAMESPACE,
		collections: {
			notes: {
				kind: 'table',
				recordKeys: [NOTE_B, NOTE_A],
				allowCreate,
			},
			settings: {
				kind: 'values',
				recordKeys: ['theme', 'filters'],
			},
		},
	};
}

function sourceRecords(): ProposalSourceRecord[] {
	return [
		{
			address: {
				namespace: NAMESPACE,
				collection: 'notes',
				recordKey: NOTE_A,
			},
			state: 'live',
			payload: {
				title: 'First',
				done: true,
				labels: ['local'],
				metadata: null,
				unknown: { preserved: true },
			},
		},
		{
			address: {
				namespace: NAMESPACE,
				collection: 'notes',
				recordKey: NOTE_B,
			},
			state: 'live',
			payload: { title: 'Second', unknown: 42 },
		},
		{
			address: {
				namespace: NAMESPACE,
				collection: 'settings',
				recordKey: 'theme',
			},
			state: 'live',
			payload: 'light',
		},
		{
			address: {
				namespace: NAMESPACE,
				collection: 'settings',
				recordKey: 'filters',
			},
			state: 'absent',
		},
	];
}

function openDraft(allowCreate = true) {
	const raw = new Database(':memory:', { strict: true });
	const database = createBunSqliteAdapter(raw);
	writeProposalArtifact({
		database,
		hmacKey: HMAC_KEY,
		proposalId: 'proposal0000000000000001',
		sourceReplicaId: 'replica00000000000000001',
		sourceAuthorityLifetime: 'authority-lifetime-one',
		lens: proposalLens(),
		selection: proposalSelection(allowCreate),
		records: sourceRecords(),
	});
	return { raw, database };
}

describe('Proposal artifacts', () => {
	test('writes complete raw base data and editable Lens tables', () => {
		const { raw } = openDraft();
		try {
			expect(
				raw
					.query(
						`SELECT kind, format_version FROM _epicenter_artifact
						WHERE singleton = 1`,
					)
					.get(),
			).toEqual({ kind: 'proposal', format_version: 1 });
			expect(
				raw
					.query(
						`SELECT state, payload_json FROM _epicenter_proposal_base
						WHERE collection = 'notes' AND record_key = ?`,
					)
					.get(NOTE_A),
			).toEqual({
				state: 'live',
				payload_json:
					'{"done":true,"labels":["local"],"metadata":null,"title":"First","unknown":{"preserved":true}}',
			});
			expect(raw.query('SELECT * FROM notes ORDER BY id').all()).toEqual([
				{
					id: NOTE_A,
					title: 'First',
					done: 1,
					labels: '["local"]',
					metadata: 'null',
				},
				{
					id: NOTE_B,
					title: 'Second',
					done: null,
					labels: null,
					metadata: null,
				},
			]);
			expect(raw.query('SELECT * FROM settings').get()).toEqual({
				singleton: 1,
				theme: 'light',
				filters: null,
			});
		} finally {
			raw.close();
		}
	});

	test('refuses source rows that are missing, extra, absent tables, or nonconforming', () => {
		const absentTable = sourceRecords();
		absentTable[0] = {
			address: {
				namespace: NAMESPACE,
				collection: 'notes',
				recordKey: NOTE_A,
			},
			state: 'absent',
		};
		const nonconforming = sourceRecords();
		nonconforming[0] = {
			address: {
				namespace: NAMESPACE,
				collection: 'notes',
				recordKey: NOTE_A,
			},
			state: 'live',
			payload: { title: 42 },
		};
		const cases: ProposalSourceRecord[][] = [
			sourceRecords().slice(1),
			[
				...sourceRecords(),
				{
					address: {
						namespace: NAMESPACE,
						collection: 'notes',
						recordKey: 'cccccccccccccccccccccccc',
					},
					state: 'live',
					payload: { title: 'Extra' },
				},
			],
			absentTable,
			nonconforming,
		];
		for (const records of cases) {
			const raw = new Database(':memory:', { strict: true });
			try {
				expect(() =>
					writeProposalArtifact({
						database: createBunSqliteAdapter(raw),
						hmacKey: HMAC_KEY,
						proposalId: 'proposal0000000000000001',
						sourceReplicaId: 'replica00000000000000001',
						sourceAuthorityLifetime: 'authority-lifetime-one',
						lens: proposalLens(),
						selection: proposalSelection(),
						records,
					}),
				).toThrow();
				expect(
					raw
						.query(
							`SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'`,
						)
						.all(),
				).toEqual([]);
			} finally {
				raw.close();
			}
		}
	});

	test('compiles ordered patches, tombstones, unsets, and collision-refusing creates', () => {
		const { raw, database } = openDraft();
		try {
			raw.run(`UPDATE notes SET title = 'Edited', done = NULL WHERE id = ?`, [
				NOTE_A,
			]);
			raw.run('DELETE FROM notes WHERE id = ?', [NOTE_B]);
			raw.run(
				`INSERT INTO notes (title, labels, metadata)
				VALUES ('Created', '["new"]', 'null')`,
			);
			raw.run(
				`UPDATE settings SET theme = NULL, filters = '["open"]'
				WHERE singleton = 1`,
			);
			const draftId = (
				raw
					.query<{ id: string }, []>(
						`SELECT id FROM notes WHERE title = 'Created'`,
					)
					.get() as { id: string }
			).id;
			expect(draftId).toMatch(/^[a-f0-9]{24}$/);
			const newId = 'cccccccccccccccccccccccc';
			raw.run('UPDATE notes SET id = ? WHERE id = ?', [newId, draftId]);

			const manifest = compileProposalArtifact({ database, hmacKey: HMAC_KEY });
			expect(manifest.entries).toEqual([
				{
					address: {
						namespace: NAMESPACE,
						collection: 'notes',
						recordKey: NOTE_A,
					},
					op: 'patch',
					set: { title: 'Edited' },
					unset: ['done'],
				},
				{
					address: {
						namespace: NAMESPACE,
						collection: 'notes',
						recordKey: NOTE_B,
					},
					op: 'tombstone',
				},
				{
					address: {
						namespace: NAMESPACE,
						collection: 'notes',
						recordKey: newId,
					},
					op: 'replace',
					value: { title: 'Created', labels: ['new'], metadata: null },
					collision: 'refuse',
				},
				{
					address: {
						namespace: NAMESPACE,
						collection: 'settings',
						recordKey: 'filters',
					},
					op: 'replace',
					value: ['open'],
				},
				{
					address: {
						namespace: NAMESPACE,
						collection: 'settings',
						recordKey: 'theme',
					},
					op: 'unset',
				},
			]);
			expect(readProposalManifest({ database, hmacKey: HMAC_KEY })).toEqual(
				manifest,
			);
			expect(
				advanceProposalWatermark({
					database,
					hmacKey: HMAC_KEY,
					fromAppliedCount: 0,
				}),
			).toBe(1);
			expect(
				readProposalManifest({ database, hmacKey: HMAC_KEY }).appliedCount,
			).toBe(1);
		} finally {
			raw.close();
		}
	});

	test('refuses new rows when the exact selection does not allow creation', () => {
		const { raw, database } = openDraft(false);
		try {
			raw.run(`INSERT INTO notes (title) VALUES ('Not allowed')`);
			expect(() =>
				compileProposalArtifact({ database, hmacKey: HMAC_KEY }),
			).toThrow("Proposal table 'notes' does not allow creation");
		} finally {
			raw.close();
		}
	});

	test('seals one manifest generation and never resets Apply progress', () => {
		for (const advance of [false, true]) {
			const { raw, database } = openDraft();
			try {
				raw.run(`UPDATE notes SET title = 'Edited' WHERE id = ?`, [NOTE_A]);
				compileProposalArtifact({ database, hmacKey: HMAC_KEY });
				if (advance) {
					advanceProposalWatermark({
						database,
						hmacKey: HMAC_KEY,
						fromAppliedCount: 0,
					});
				}
				expect(() =>
					compileProposalArtifact({ database, hmacKey: HMAC_KEY }),
				).toThrow('Proposal manifest is already sealed');
				expect(
					readProposalManifest({ database, hmacKey: HMAC_KEY }).appliedCount,
				).toBe(advance ? 1 : 0);
			} finally {
				raw.close();
			}
		}
	});

	test('refuses edited creation keys outside the draft-time 24-hex form', () => {
		for (const recordKey of ['foo', 'g'.repeat(24)]) {
			const { raw, database } = openDraft();
			try {
				raw.run('INSERT INTO notes (id, title) VALUES (?, ?)', [
					recordKey,
					'Invalid key',
				]);
				expect(() =>
					compileProposalArtifact({ database, hmacKey: HMAC_KEY }),
				).toThrow(/invalid new ID/);
			} finally {
				raw.close();
			}
		}
	});

	test('refuses a friendly edit that cannot enter the ordinary protocol', () => {
		const { raw, database } = openDraft();
		try {
			raw.run('UPDATE notes SET title = ? WHERE id = ?', [
				'x'.repeat(SCALAR_SYNC_V1_LIMITS.maxEncodedFactBytes),
				NOTE_A,
			]);
			expect(() =>
				compileProposalArtifact({ database, hmacKey: HMAC_KEY }),
			).toThrow(/manifest entry is inadmissible/);
			expect(() =>
				readProposalManifest({ database, hmacKey: HMAC_KEY }),
			).toThrow('Proposal has not been compiled');
		} finally {
			raw.close();
		}
	});

	test('refuses extra schema objects and sealed raw-base tampering', () => {
		for (const tamper of [
			(raw: Database) => raw.run('CREATE TABLE intruder (value TEXT) STRICT'),
			(raw: Database) =>
				raw.run(
					`UPDATE _epicenter_proposal_base SET payload_json = '{"title":"forged"}'
					WHERE collection = 'notes' AND record_key = ?`,
					[NOTE_A],
				),
		]) {
			const { raw, database } = openDraft();
			try {
				tamper(raw);
				expect(() =>
					compileProposalArtifact({ database, hmacKey: HMAC_KEY }),
				).toThrow();
			} finally {
				raw.close();
			}
		}
	});

	test('refuses manifest and watermark tampering after compilation', () => {
		for (const tamper of [
			(raw: Database) =>
				raw.run(
					`UPDATE _epicenter_proposal_manifest
					SET entry_json = '{"op":"unset"}' WHERE sequence = 0`,
				),
			(raw: Database) =>
				raw.run(
					`UPDATE _epicenter_proposal_apply SET applied_count = 1
					WHERE singleton = 1`,
				),
		]) {
			const { raw, database } = openDraft();
			try {
				raw.run(`UPDATE notes SET title = 'Edited' WHERE id = ?`, [NOTE_A]);
				compileProposalArtifact({ database, hmacKey: HMAC_KEY });
				tamper(raw);
				expect(() =>
					readProposalManifest({ database, hmacKey: HMAC_KEY }),
				).toThrow();
			} finally {
				raw.close();
			}
		}
	});
});

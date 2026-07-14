/**
 * SQLite Workspace Definition Tests
 *
 * Verifies the terminal persisted-schema boundary before any database opens.
 * The boundary accepts only the closed field vocabulary, compiles value
 * checks, validates table options and references, derives the canonical
 * schema descriptor plus `recordsSchemaHash`, and derives version-qualified
 * identities for every declared durable plane. Declared KV is validated as a
 * plain record but contributes nothing to record schema identity. Definitions
 * own immutable snapshots of every mutable authoring record and schema.
 */

import { describe, expect, test } from 'bun:test';
import { RECORD_SYNC_ADMISSION_LIMITS } from '@epicenter/record-sync';
import { type TObject, type TSchema, type TString, Type } from 'typebox';
import { Value } from 'typebox/value';
import { nullable } from '../document/nullable.js';
import { sha256Hex } from '../shared/sha256.js';
import { defineKv, defineTable, defineWorkspace } from './definition.js';
import { document } from './document-format.js';
import { field } from './field.js';

describe('defineTable', () => {
	test('compiles fields and accepts closed document capabilities', () => {
		const notes = defineTable({
			fields: {
				id: field.id(),
				title: field.string({ minLength: 1 }),
				folderId: nullable(field.reference('folders')),
				pinned: field.boolean(),
				body: field.doc(document.xmlFragment),
			},
		});

		expect(notes.compiledColumns.title.storage).toBe('TEXT');
		expect(notes.compiledColumns.title.check('hello')).toBe(true);
		expect(notes.compiledColumns.title.check('')).toBe(false);
		expect(notes.compiledColumns.folderId.isNullable).toBe(true);
		expect(notes.compiledColumns.folderId.referenceTable).toBe('folders');
		expect(notes.documents.body).toBe(document.xmlFragment);
	});

	test('derives columns and documents from one field map', () => {
		const notes = defineTable({
			fields: {
				id: field.id(),
				body: field.doc(document.plainText),
				audio: field.blob(),
			},
		});

		expect('body' in notes.compiledColumns).toBe(false);
		expect(notes.documents.body).toBe(document.plainText);
		expect(notes.compiledColumns.audio.kind).toBe('json');
		expect(
			notes.compiledColumns.audio.check({
				hash: '0'.repeat(64),
				size: 1,
				mediaType: 'audio/wav',
			}),
		).toBe(true);
		expect(
			notes.compiledColumns.audio.check({
				hash: '0'.repeat(64),
				size: 0,
				mediaType: 'audio/wav',
			}),
		).toBe(false);
		expect(notes.blobs.audio).toEqual(notes.fields.audio);
	});

	test('rejects raw TypeBox schemas and invalid table options', () => {
		expect(() =>
			defineTable({
				fields: {
					id: field.id(),
					raw: Type.Object({ x: Type.String() }),
				},
			}),
		).toThrow("Persisted field 'raw' must use field.* or nullable(field.*)");
		expect(() =>
			defineTable({
				fields: {
					id: field.id(),
					'bad.name': field.doc(document.plainText),
				},
			}),
		).toThrow('Invalid child document field name');
		expect(() =>
			defineTable({
				fields: { id: field.id(), constructor: field.string() },
			}),
		).toThrow("table field 'constructor' collides with Object.prototype");
	});

	test('requires the non-null Epicenter id field', () => {
		const table = defineTable({ fields: { id: field.id() } });
		const defineInvalidTable = (id: TSchema) =>
			defineTable({ fields: { id } } as unknown as Parameters<
				typeof defineTable
			>[0]);
		expect(table.compiledColumns.id.check('abcdefghijklmnop')).toBe(true);
		expect(
			table.compiledColumns.id.check('550e8400-e29b-41d4-a716-446655440000'),
		).toBe(true);
		expect(table.compiledColumns.id.check('contains a space')).toBe(false);
		expect(table.compiledColumns.id.check('contains/a/slash')).toBe(false);
		expect(() => defineInvalidTable(field.string())).toThrow(
			"column 'id' must be a non-null field.id()",
		);
		expect(() => defineInvalidTable(field.number())).toThrow(
			"column 'id' must be a non-null field.id()",
		);
		expect(() => defineInvalidTable(nullable(field.string()))).toThrow(
			"column 'id' must be a non-null field.id()",
		);
	});

	test('compiled checks reject non-JSON and non-finite values', () => {
		const nullablePayload = nullable(field.json(Type.Unknown()));
		const values = defineTable({
			fields: {
				id: field.id(),
				payload: nullablePayload,
				number: field.number(),
			},
		});

		expect(values.compiledColumns.payload.check(new Date())).toBe(false);
		expect(values.compiledColumns.payload.check({ nested: ['ok', 1] })).toBe(
			true,
		);
		expect(values.compiledColumns.payload.check(null)).toBe(true);
		expect(values.compiledColumns.number.check(Number.NaN)).toBe(false);
		expect(values.compiledColumns.number.check(Number.POSITIVE_INFINITY)).toBe(
			false,
		);
	});

	test('rejects implicit null and undeclared row cells', () => {
		const implicitNull = field.json(Type.Unknown()) as unknown as TString;
		expect(() =>
			defineTable({ fields: { id: field.id(), payload: implicitNull } }),
		).toThrow("field 'payload' admits null");

		const notes = defineTable({
			fields: { id: field.id(), title: field.string() },
		});
		expect(
			Value.Check(notes.schema, { id: 'note-1', title: 'Hi', extra: true }),
		).toBe(false);
	});

	test('owns immutable field and document snapshots', () => {
		const title = field.string({ minLength: 2 });
		const fields = {
			id: field.id(),
			title,
			body: field.doc(document.plainText),
		};
		const notes = defineTable({ fields });
		const workspace = defineWorkspace({
			appId: 'notes',
			version: 1,
			tables: { notes },
		});
		const descriptor = workspace.recordsDescriptor;
		const hash = workspace.recordsSchemaHash;

		Object.assign(title, { minLength: 100 });
		Object.assign(fields, { title: field.number() });
		Object.assign(fields, { body: field.doc(document.xmlFragment) });

		expect(notes.fields.title).not.toBe(title);
		expect(notes.compiledColumns.title.check('ok')).toBe(true);
		expect(notes.compiledColumns.title.check(42)).toBe(false);
		expect(Value.Check(notes.schema, { id: 'note-1', title: 'ok' })).toBe(true);
		expect(notes.documents.body).toBe(document.plainText);
		expect(workspace.recordsDescriptor).toBe(descriptor);
		expect(workspace.recordsSchemaHash).toBe(hash);
		expect(Object.isFrozen(notes)).toBe(true);
		expect(Object.isFrozen(notes.fields)).toBe(true);
		expect(Object.isFrozen(notes.fields.title)).toBe(true);
		expect(Object.isFrozen(notes.documents)).toBe(true);
		expect(Object.isFrozen(notes.compiledColumns)).toBe(true);
	});
});

describe('defineKv', () => {
	test('carries the schema and a factory default', () => {
		const collapsed = defineKv(field.boolean(), () => false);
		expect(collapsed.schema).toEqual(field.boolean());
		expect(collapsed.defaultValue()).toBe(false);
	});

	test('accepts nullable KV: null is a real stored preference off the record wire', () => {
		const lastFolder = defineKv(nullable(field.string()), () => null);
		expect(lastFolder.defaultValue()).toBeNull();
		const workspace = defineWorkspace({
			appId: 'nullable-kv',
			version: 1,
			tables: { rows: defineTable({ fields: { id: field.id() } }) },
			kv: { lastFolder },
		});
		expect(workspace.kv.lastFolder).toBe(lastFolder);
	});
});

describe('defineWorkspace', () => {
	test('derives the kv document guid, defaults the display name, and validates references', () => {
		const folders = defineTable({
			fields: { id: field.id(), name: field.string() },
		});
		const notes = defineTable({
			fields: {
				id: field.id(),
				folderId: nullable(field.reference('folders')),
			},
		});
		const workspace = defineWorkspace({
			appId: 'notes',
			version: 1,
			tables: { folders, notes },
		});

		expect(workspace.name).toBe('notes');
		expect(workspace.workspaceId).toBe('notes-v1');
		expect(workspace.kvDocumentGuid).toBe('notes-v1.kv');
		expect(workspace.kv).toEqual({});
		expect(
			defineWorkspace({
				appId: 'notes',
				version: 1,
				name: 'Notes',
				tables: { notes: folders },
			}).name,
		).toBe('Notes');
		expect(() =>
			defineWorkspace({
				appId: 'broken',
				version: 1,
				tables: {
					notes: defineTable({
						fields: {
							id: field.id(),
							folderId: field.reference('folders'),
						},
					}),
				},
			}),
		).toThrow("references unknown table 'folders'");
	});

	test('recordsSchemaHash is a labelled digest of the canonical descriptor bytes', () => {
		const workspace = defineWorkspace({
			appId: 'notes',
			version: 1,
			tables: {
				notes: defineTable({
					fields: { id: field.id(), title: field.string() },
				}),
			},
		});
		expect(workspace.recordsSchemaHash).toBe(
			`sha256:${sha256Hex(workspace.recordsDescriptor)}`,
		);
		const descriptor: unknown = JSON.parse(workspace.recordsDescriptor);
		expect(descriptor).toMatchObject({ format: 'epicenter.record-schema/1' });
	});

	test('string maxBytes participates in records identity and cannot exceed sync admission', () => {
		const hash = (maxBytes: number) =>
			defineWorkspace({
				appId: 'notes',
				version: 1,
				tables: {
					notes: defineTable({
						fields: {
							id: field.id(),
							body: field.string({ maxBytes }),
						},
					}),
				},
			}).recordsSchemaHash;

		expect(hash(4)).not.toBe(hash(5));
		expect(() =>
			hash(RECORD_SYNC_ADMISSION_LIMITS.encodedCellBytes + 1),
		).toThrow('maxBytes exceeds');
	});

	test('recordsSchemaHash is stable across declaration order, display name, kv, and documents', () => {
		const first = defineWorkspace({
			appId: 'notes',
			version: 1,
			name: 'First display name',
			tables: {
				notes: defineTable({
					fields: {
						id: field.id(),
						title: field.string(),
						updatedAt: field.instant(),
						summary: field.doc(document.plainText),
						body: field.doc(document.xmlFragment),
					},
				}),
				folders: defineTable({
					fields: { name: field.string(), id: field.id() },
				}),
			},
			kv: {
				theme: defineKv(
					field.select(['light', 'dark']),
					() => 'light' as const,
				),
				collapsed: defineKv(field.boolean(), () => false),
			},
		});
		const reordered = defineWorkspace({
			appId: 'notes',
			version: 1,
			name: 'Different display name',
			tables: {
				folders: defineTable({
					fields: { id: field.id(), name: field.string() },
				}),
				notes: defineTable({
					fields: {
						title: field.string(),
						updatedAt: field.instant(),
						id: field.id(),
						body: field.doc(document.xmlFragment),
						summary: field.doc(document.plainText),
					},
				}),
			},
			kv: {},
		});

		expect(reordered.recordsSchemaHash).toBe(first.recordsSchemaHash);
		expect(reordered.recordsDescriptor).toBe(first.recordsDescriptor);
	});

	test('annotation edits are free: title, description, and default do not change recordsSchemaHash', () => {
		function hashWithTitle(title: string | undefined) {
			return defineWorkspace({
				appId: 'notes',
				version: 1,
				tables: {
					notes: defineTable({
						fields: {
							id: field.id(),
							status: field.select(['open', 'done'], {
								...(title === undefined ? {} : { title }),
								description: `described as ${title ?? 'nothing'}`,
							}),
						},
					}),
				},
			}).recordsSchemaHash;
		}
		expect(hashWithTitle('Status')).toBe(hashWithTitle(undefined));
		expect(hashWithTitle('Renamed label')).toBe(hashWithTitle(undefined));
	});

	test('field.json root annotations are stripped; nested annotations stay identity', () => {
		function hashWithPayload(payload: TObject) {
			return defineWorkspace({
				appId: 'notes',
				version: 1,
				tables: {
					notes: defineTable({
						fields: {
							id: field.id(),
							payload: field.json(payload),
						},
					}),
				},
			}).recordsSchemaHash;
		}

		// The payload spreads onto the column root, so a root default or title
		// is a stripped editor hint: no accepted value changes, no new version.
		const baseline = hashWithPayload(Type.Object({ level: Type.Number() }));
		expect(
			hashWithPayload(
				Type.Object({ level: Type.Number() }, { title: 'Payload' }),
			),
		).toBe(baseline);

		// A nested annotation survives (stated cost of non-recursive stripping),
		// and a nested structural change is identity as it must be.
		expect(
			hashWithPayload(
				Type.Object({ level: Type.Number({ description: 'depth' }) }),
			),
		).not.toBe(baseline);
		expect(hashWithPayload(Type.Object({ level: Type.String() }))).not.toBe(
			baseline,
		);
	});

	test('recordsSchemaHash changes with record fields, not documents or app id', () => {
		type IdentityOptions = {
			appId?: string;
			title?: ReturnType<typeof field.string>;
			doc?: typeof document.plainText | typeof document.xmlFragment;
		};
		function identity({
			appId = 'notes',
			title = field.string(),
			doc = document.plainText,
		}: IdentityOptions = {}) {
			return defineWorkspace({
				appId,
				version: 1,
				tables: {
					notes: defineTable({
						fields: { id: field.id(), title, body: field.doc(doc) },
					}),
				},
			}).recordsSchemaHash;
		}

		const baseline = identity();
		expect(identity({ title: field.string({ minLength: 1 }) })).not.toBe(
			baseline,
		);
		expect(identity({ doc: document.xmlFragment })).toBe(baseline);
		// Family routing owns workspace binding; two workspaces with one logical
		// schema share one hash by design.
		expect(identity({ appId: 'other' })).toBe(baseline);
	});

	test('KV is not record schema identity: definitions differing only in kv share one hash', () => {
		function withKv(kv: Record<string, ReturnType<typeof defineKv>>) {
			return defineWorkspace({
				appId: 'notes',
				version: 1,
				tables: {
					notes: defineTable({
						fields: { id: field.id(), title: field.string() },
					}),
				},
				kv,
			}).recordsSchemaHash;
		}

		const withoutKv = withKv({});
		const withTheme = withKv({
			theme: defineKv(field.select(['light', 'dark']), () => 'light' as const),
		});
		const withChangedTheme = withKv({
			theme: defineKv(field.boolean(), () => false),
		});
		expect(withTheme).toBe(withoutKv);
		expect(withChangedTheme).toBe(withoutKv);
	});

	test('document identity rejects unsafe workspace and table segments', () => {
		const documented = defineTable({
			fields: {
				id: field.id(),
				body: field.doc(document.plainText),
			},
		});
		expect(() =>
			defineWorkspace({
				appId: 'Unsafe',
				version: 1,
				tables: { notes: documented },
			}),
		).toThrow('Invalid application id');
		expect(() =>
			defineWorkspace({
				appId: 'safe',
				version: 1,
				tables: { 'bad.table': documented },
			}),
		).toThrow('Invalid child document table name');
	});

	test('rejects schema names that collide with record prototypes', () => {
		const rows = defineTable({ fields: { id: field.id() } });
		expect(() =>
			defineWorkspace({
				appId: 'rows',
				version: 1,
				tables: { constructor: rows },
			}),
		).toThrow("workspace table 'constructor' collides with Object.prototype");
		expect(() =>
			defineWorkspace({
				appId: 'rows',
				version: 1,
				tables: { rows },
				kv: { toString: defineKv(field.string(), () => '') },
			}),
		).toThrow("workspace KV key 'toString' collides with Object.prototype");
		expect(() =>
			defineWorkspace({
				appId: 'rows',
				version: 1,
				tables: { rows, __proto__: rows },
			}),
		).toThrow('workspace tables must be a plain record');
		expect(() =>
			defineWorkspace({
				appId: 'rows',
				version: 1,
				tables: { rows, ['__proto__']: rows },
			}),
		).toThrow("workspace table '__proto__' collides with Object.prototype");
	});

	test('rejects an empty KV key before proposing an unpublishable lock entry', () => {
		expect(() =>
			defineWorkspace({
				appId: 'empty-kv-key',
				version: 1,
				tables: {
					rows: defineTable({ fields: { id: field.id() } }),
				},
				kv: { '': defineKv(field.string(), () => '') },
			}),
		).toThrow('Workspace KV key must not be empty');
	});

	test('owns immutable table and KV declaration maps', () => {
		const notes = defineTable({ fields: { id: field.id() } });
		const theme = defineKv(field.string(), () => 'light');
		const tables: Record<string, typeof notes> = { notes };
		const kv: Record<string, typeof theme> = { theme };
		const workspace = defineWorkspace({
			appId: 'notes',
			version: 1,
			tables,
			kv,
		});
		const descriptor = workspace.recordsDescriptor;
		const hash = workspace.recordsSchemaHash;

		tables.archive = notes;
		kv.locale = theme;
		delete tables.notes;
		delete kv.theme;

		expect(Object.keys(workspace.tables)).toEqual(['notes']);
		expect(Object.keys(workspace.kv)).toEqual(['theme']);
		expect(workspace.recordsDescriptor).toBe(descriptor);
		expect(workspace.recordsSchemaHash).toBe(hash);
		expect(Object.isFrozen(workspace)).toBe(true);
		expect(Object.isFrozen(workspace.tables)).toBe(true);
		expect(Object.isFrozen(workspace.kv)).toBe(true);
	});

	test('refuses table and KV lookalikes without factory provenance', () => {
		const notes = defineTable({ fields: { id: field.id() } });
		const theme = defineKv(field.string(), () => 'light');

		expect(() =>
			defineWorkspace({
				appId: 'forged-table',
				version: 1,
				tables: { notes: { ...notes } },
			}),
		).toThrow("Workspace table 'notes' must use defineTable()");
		expect(() =>
			defineWorkspace({
				appId: 'forged-kv',
				version: 1,
				tables: { notes },
				kv: { theme: { ...theme } },
			}),
		).toThrow("Workspace KV key 'theme' must use defineKv()");
	});
});

test('defineTable refuses shapes the record wire cannot admit', () => {
	const oversizedColumns = Object.fromEntries([
		['id', field.id()],
		...Array.from({ length: 129 }, (_, index) => [
			`column${index}`,
			field.string(),
		]),
	]);
	expect(() =>
		defineTable({ fields: oversizedColumns } as Parameters<
			typeof defineTable
		>[0]),
	).toThrow('cells per operation');
	expect(() =>
		defineTable({
			fields: {
				id: field.id(),
				['x'.repeat(513)]: field.string(),
			},
		}),
	).toThrow('wire identifier ceiling');
});

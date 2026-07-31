/**
 * `retain` is the one rebuild behavior a declaration gets to choose, and it is
 * the difference between a shape change costing CPU and costing a full re-pull.
 */

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MailMessage, mailMirror } from '../mirrors/mail.ts';
import {
	defineMirror,
	type MirrorDeclaration,
	openMirrorReader,
	openMirrorWriter,
	path,
	type Retention,
	type TableMap,
	table,
} from '../src/index.ts';

const directories: string[] = [];

function mirrorPath(): string {
	const directory = mkdtempSync(join(tmpdir(), 'mirror-api-'));
	directories.push(directory);
	return join(directory, 'mirror.sqlite3');
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

type Note = {
	id: string;
	rev: string;
	title: string;
	author?: { name: string };
	trashed?: boolean;
};

const note = (overrides: Partial<Note> = {}): Note => ({
	id: 'n1',
	rev: '2026-07-01T00:00:00Z',
	title: 'first',
	author: { name: 'ada' },
	...overrides,
});

/** Same authority, two declarations: one column, then two. */
function notes(retain: Retention, withAuthor: boolean) {
	return defineMirror({
		name: 'notes',
		tables: {
			notes: table<Note>({
				retain,
				key: path('id'),
				version: { from: path('rev'), order: 'lexical' },
				tombstone: path('trashed'),
				columns: {
					title: { type: 'text', from: path('title') },
					...(withAuthor
						? {
								author: {
									type: 'text' as const,
									from: path('author', 'name'),
									nullable: true,
								},
							}
						: {}),
				},
			}),
		},
	});
}

function rows(
	declaration: MirrorDeclaration<TableMap>,
	file: string,
	sql: string,
): unknown[] {
	const opened = openMirrorReader(declaration, { path: file });
	if (opened.status !== 'fresh') throw new Error(opened.status);
	using reader = opened;
	return reader.query(sql);
}

function columnNames(file: string, tableName: string): string[] {
	const database = new Database(file, { readonly: true });
	const names = database
		.query<{ name: string }, []>(`PRAGMA table_info("${tableName}")`)
		.all()
		.map((row) => row.name);
	database.close(false);
	return names;
}

describe('retention is stored shape', () => {
	test('raw is the default and keeps the authority object beside the columns', () => {
		const file = mirrorPath();
		using writer = openMirrorWriter(notes('raw', false), { path: file });
		writer.ingest({ notes: [note()] });
		expect(columnNames(file, 'notes')).toContain('_raw');
	});

	test('projected stores only what was declared', () => {
		const file = mirrorPath();
		using writer = openMirrorWriter(notes('projected', false), { path: file });
		writer.ingest({ notes: [note()] });
		expect(columnNames(file, 'notes')).not.toContain('_raw');
	});

	test('changing retention is itself a rebuild', () => {
		expect(notes('raw', false).fingerprint).not.toBe(
			notes('projected', false).fingerprint,
		);
	});
});

describe('a shape change on a raw mirror is answered locally', () => {
	test('the new column is filled from payloads already on disk', () => {
		const file = mirrorPath();
		{
			using writer = openMirrorWriter(notes('raw', false), { path: file });
			writer.ingest({ notes: [note()] }, { cursor: 'c1', full: ['notes'] });
		}
		using widened = openMirrorWriter(notes('raw', true), { path: file });
		expect(widened.rebuilt).toBe(true);
		expect(widened.needsBackfill).toEqual([]);
		expect(widened.cursor).toBe('c1');
		// `author` was never pulled under the old declaration. It is here anyway,
		// because the authority object it came from was never thrown away.
		expect(
			rows(notes('raw', true), file, 'SELECT title, author FROM notes'),
		).toEqual([{ title: 'first', author: 'ada' }]);
	});

	test('a tombstone reprojects as a tombstone, so it still blocks a stale write', () => {
		const file = mirrorPath();
		{
			using writer = openMirrorWriter(notes('raw', false), { path: file });
			writer.ingest({ notes: [note()] });
			writer.ingest({
				notes: [note({ rev: '2026-07-05T00:00:00Z', trashed: true })],
			});
		}
		using widened = openMirrorWriter(notes('raw', true), { path: file });
		expect(
			rows(notes('raw', true), file, 'SELECT _deleted, _version FROM notes'),
		).toEqual([{ _deleted: 1, _version: '2026-07-05T00:00:00Z' }]);

		const report = widened.ingest({
			notes: [note({ rev: '2026-07-02T00:00:00Z' })],
		});
		expect(report.rejectedStale).toBe(1);
	});

	test('an imperative derivation is re-run, not restored', () => {
		const file = mirrorPath();
		const message: MailMessage = {
			id: 'm1',
			threadId: 't1',
			historyId: 100,
			labelIds: ['INBOX', 'SENT'],
			internalDate: '1750000000000',
			payload: {
				mimeType: 'multipart/mixed',
				headers: [{ name: 'Subject', value: 'hi' }],
				parts: [
					{
						partId: '0',
						mimeType: 'application/pdf',
						filename: 'a.pdf',
						body: { attachmentId: 'att-a', size: 5 },
					},
				],
			},
		};
		{
			using writer = openMirrorWriter(mailMirror, { path: file });
			writer.ingest(
				{ messages: [message] },
				{ cursor: '100', full: ['messages'] },
			);
		}
		// A forced rebuild is the "the derive body changed" case: the fingerprint
		// cannot see it, and the fix must not cost a re-download of the mailbox.
		using forced = openMirrorWriter(mailMirror, { path: file, rebuild: true });
		expect(forced.needsBackfill).toEqual([]);
		expect(forced.cursor).toBe('100');
		expect(
			rows(mailMirror, file, 'SELECT count(*) AS n FROM attachments'),
		).toEqual([{ n: 1 }]);
		expect(rows(mailMirror, file, 'SELECT count(*) AS n FROM labels')).toEqual([
			{ n: 2 },
		]);
	});
});

describe('a shape change on a projected mirror costs a re-pull', () => {
	test('rows, cursor and latch all go, because nothing local can rebuild them', () => {
		const file = mirrorPath();
		{
			using writer = openMirrorWriter(notes('projected', false), {
				path: file,
			});
			writer.ingest({ notes: [note()] }, { cursor: 'c1', full: ['notes'] });
		}
		using widened = openMirrorWriter(notes('projected', true), { path: file });
		expect(widened.rebuilt).toBe(true);
		expect(widened.needsBackfill).toEqual(['notes']);
		expect(widened.cursor).toBeNull();
		expect(
			rows(notes('projected', true), file, 'SELECT count(*) AS n FROM notes'),
		).toEqual([{ n: 0 }]);
	});

	test('adopting retention later cannot recover what was never kept', () => {
		const file = mirrorPath();
		{
			using writer = openMirrorWriter(notes('projected', false), {
				path: file,
			});
			writer.ingest({ notes: [note()] }, { cursor: 'c1', full: ['notes'] });
		}
		using adopted = openMirrorWriter(notes('raw', false), { path: file });
		expect(adopted.needsBackfill).toEqual(['notes']);
		expect(adopted.cursor).toBeNull();
	});
});

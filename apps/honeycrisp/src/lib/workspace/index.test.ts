/**
 * Honeycrisp Lens Tests
 *
 * Exercises Honeycrisp's inert Lens through the real Bun record runtime.
 *
 * Key behaviors:
 * - the runtime mints structural row ids
 * - folder deletion unsets note foreign keys before deleting the folder
 * - record-owned note documents survive runtime disposal and reopen
 * - record deletion revokes an already-open note document
 */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBunEpicenter } from '@epicenter/data/runtime/bun';
import { InstantString } from '@epicenter/field';
import { expectOk } from 'wellcrafted/testing';
import { deleteHoneycrispFolder, honeycrispLens } from './index.js';

test('runtime-minted rows support optional fields and folder re-parenting', async () => {
	const storageRoot = mkdtempSync(join(tmpdir(), 'epicenter-honeycrisp-'));
	try {
		await using epicenter = await openBunEpicenter({
			database: join(storageRoot, 'epicenter.sqlite3'),
			owner: null,
		});
		const honeycrisp = epicenter.bind(honeycrispLens);
		const folder = await honeycrisp.folders.create({
			name: 'Projects',
			sortOrder: 0,
		});
		const now = InstantString.now();
		const note = await honeycrisp.notes.create({
			folderId: folder.id,
			title: 'Cut over Honeycrisp',
			preview: 'Use canonical rows',
			pinned: false,
			createdAt: now,
			updatedAt: now,
		});

		expect(note.id).toBeString();
		expect(note.id).not.toBe(folder.id);
		await deleteHoneycrispFolder(honeycrisp, folder.id);

		const folders = await honeycrisp.folders.scan();
		const notes = await honeycrisp.notes.scan();
		expect(folders.rows).toEqual([]);
		expect(notes.nonconforming).toEqual([]);
		expect(notes.rows).toHaveLength(1);
		expect(notes.rows[0]).toMatchObject({
			id: note.id,
			title: note.title,
		});
		expect(notes.rows[0]).not.toHaveProperty('folderId');
	} finally {
		rmSync(storageRoot, { recursive: true, force: true });
	}
});

test('note body documents remain durable across runtime reopen', async () => {
	const storageRoot = mkdtempSync(join(tmpdir(), 'epicenter-honeycrisp-'));
	try {
		let noteId: string;
		{
			await using epicenter = await openBunEpicenter({
				database: join(storageRoot, 'epicenter.sqlite3'),
				owner: null,
			});
			const honeycrisp = epicenter.bind(honeycrispLens);
			const now = InstantString.now();
			const note = await honeycrisp.notes.create({
				title: 'Durable body',
				preview: '',
				pinned: false,
				createdAt: now,
				updatedAt: now,
			});
			noteId = note.id;
			await using document = expectOk(
				await honeycrisp.notes.record(note.id).document.open(),
			);
			const body = document.get('body');
			document.transact(() => body.insert(0, 'Persisted body'));
			await document.whenDurable();
		}

		await using reopenedEpicenter = await openBunEpicenter({
			database: join(storageRoot, 'epicenter.sqlite3'),
			owner: null,
		});
		const reopened = reopenedEpicenter.bind(honeycrispLens);
		await using document = expectOk(
			await reopened.notes.record(noteId).document.open(),
		);
		expect(document.get('body').toString()).toBe('Persisted body');
	} finally {
		rmSync(storageRoot, { recursive: true, force: true });
	}
});

test('deleting a note revokes its open body document', async () => {
	const storageRoot = mkdtempSync(join(tmpdir(), 'epicenter-honeycrisp-'));
	try {
		await using epicenter = await openBunEpicenter({
			database: join(storageRoot, 'epicenter.sqlite3'),
			owner: null,
		});
		const honeycrisp = epicenter.bind(honeycrispLens);
		const now = InstantString.now();
		const note = await honeycrisp.notes.create({
			title: 'Delete me',
			preview: '',
			pinned: false,
			createdAt: now,
			updatedAt: now,
		});
		await using document = expectOk(
			await honeycrisp.notes.record(note.id).document.open(),
		);

		await honeycrisp.notes.record(note.id).delete();

		expect(() => document.get('body')).toThrow('was revoked');
	} finally {
		rmSync(storageRoot, { recursive: true, force: true });
	}
});

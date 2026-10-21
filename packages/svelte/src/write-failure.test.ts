/**
 * Copyable text for held input that did not save.
 *
 * Key behaviors:
 * - A removed field is named under `remove`, never written as a value, so no
 *   value a person typed reads as a removal
 * - `null` is a value that is set, apart from a removal
 * - Whole text is copied exactly as typed
 */
import { expect, test } from 'bun:test';
import type { DocumentPending } from '@epicenter/folder/edits';
import { pendingFailure, unsavedText } from './write-failure.js';

const fields = (values: Record<string, unknown>): DocumentPending => ({
	kind: 'document',
	path: 'notes/a.md',
	fields: values,
	body: undefined,
	saving: false,
	error: undefined,
});

test('a removal, a null, and text that looks like a marker each copy as what they are', () => {
	const copied = JSON.parse(
		unsavedText(
			fields({ gone: undefined, empty: null, title: '[remove field]' }),
		),
	);
	expect(copied).toEqual({
		set: { empty: null, title: '[remove field]' },
		remove: ['gone'],
	});
});

test('removing a field and setting it to marker-like text copy differently', () => {
	expect(unsavedText(fields({ x: undefined }))).not.toBe(
		unsavedText(fields({ x: '[remove field]' })),
	);
	expect(JSON.parse(unsavedText(fields({ x: undefined })))).toEqual({
		remove: ['x'],
	});
	expect(JSON.parse(unsavedText(fields({ x: null })))).toEqual({
		set: { x: null },
	});
});

test('a row copies its fields and body; whole text copies exactly', () => {
	const row: DocumentPending = {
		kind: 'document',
		path: 'notes/a.md',
		fields: { title: 'Milk', done: undefined },
		body: 'Two litres\n',
		saving: false,
		error: undefined,
	};
	expect(JSON.parse(pendingFailure(row).unsaved)).toEqual({
		set: { title: 'Milk' },
		remove: ['done'],
		body: 'Two litres\n',
	});
	expect(
		unsavedText({
			kind: 'text',
			path: 'a.md',
			text: '﻿kept\r\n',
			saving: false,
			error: undefined,
		}),
	).toBe('﻿kept\r\n');
});

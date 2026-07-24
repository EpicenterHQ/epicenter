/**
 * Lens Compiler Tests
 *
 * Verifies ephemeral row and named-value validators derived from Lens JSON.
 *
 * Key behaviors:
 * - Projection classifies missing and invalid fields without repairing raw data
 * - Unknown stored fields stay in diagnostics but never enter projected rows
 * - Create, update, and values validation clone admitted JSON
 */
import { expect, test } from 'bun:test';

import { field } from '@epicenter/field';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { compileLens } from './compile.js';
import { defineLens, defineTable, defineValues } from './definitions.js';

function compiledFixture() {
	const lens = defineLens({
		namespace: 'so.epicenter.tests',
		title: 'Tests',
		description: 'Compiler fixture.',
		collections: {
			notes: defineTable({
				title: 'Notes',
				fields: { title: field.string(), note: field.string() },
				optional: ['note'],
			}),
			settings: defineValues({
				title: 'Settings',
				values: { theme: field.select(['light', 'dark']) },
			}),
		},
	});
	return compileLens(lens);
}

test('project excludes unknown stored fields from conforming rows', () => {
	const compiled = compiledFixture();
	const payload = { title: 'Hello', future: { retained: true } };
	const row = expectOk(compiled.notes.project('row-a', payload));
	expect(row).toEqual({ id: 'row-a', title: 'Hello' });
	expect(payload).toEqual({ title: 'Hello', future: { retained: true } });
});

test('project preserves the complete raw payload in nonconformance errors', () => {
	const error = expectErr(
		compiledFixture().notes.project('row-a', {
			title: 42,
			future: 'preserved',
		}),
	);
	expect(error).toMatchObject({
		name: 'NonconformingRow',
		key: 'notes',
		id: 'row-a',
		raw: { title: 42, future: 'preserved' },
		issues: [{ field: 'title', kind: 'invalid' }],
	});
});

test('project reports missing required fields and permits absent optional fields', () => {
	const compiled = compiledFixture();
	expect(expectErr(compiled.notes.project('row-a', {}))).toMatchObject({
		issues: [{ field: 'title', kind: 'missing' }],
	});
	expect(expectOk(compiled.notes.project('row-b', { title: 'ok' }))).toEqual({
		id: 'row-b',
		title: 'ok',
	});
});

test('normalizeUpdate unsets only optional fields and validates set fields', () => {
	const compiled = compiledFixture();
	expect(
		compiled.notes.normalizeUpdate({ title: 'next', note: undefined }),
	).toEqual({
		set: { title: 'next' },
		unset: ['note'],
	});
	expect(() => compiled.notes.normalizeUpdate({ title: undefined })).toThrow(
		"Required field 'title' cannot be unset",
	);
	expect(() => compiled.notes.normalizeUpdate({ future: true })).toThrow(
		"Unknown field 'future'",
	);
});

test('validateCreate enforces required fields and clones admitted JSON', () => {
	const compiled = compiledFixture();
	const input = { title: 'Hello', note: 'copy' };
	const payload = compiled.notes.validateCreate(input);
	expect(payload).toEqual(input);
	expect(payload).not.toBe(input);
	expect(() =>
		compiled.notes.validateCreate({ note: 'missing title' }),
	).toThrow("Missing required field 'title'");
});

test('compiled named values project, validate, clone, and classify failures', () => {
	const theme = compiledFixture().settings.theme;
	expect(expectOk(theme.project('dark'))).toBe('dark');
	expect(expectErr(theme.project('blue')).name).toBe('NonconformingValue');
	expect(theme.validate('light')).toBe('light');
	expect(() => theme.validate('blue')).toThrow(
		"Invalid value for 'settings.theme'",
	);
});

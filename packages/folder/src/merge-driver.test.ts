/**
 * Merge Driver Tests
 *
 * `mergeForGit` answers Git's merge driver with `mergeFile`'s merge, and
 * `gitMergeKind` finds a path's kind from the nearest declaration above it.
 *
 * Key behaviors:
 * - A clean merge is the merged file; competing units carry Git's markers
 *   around exactly the lines where the two sides' merges differ
 * - An empty base reads as no base, so rows added on both sides merge by field
 * - A version that is not text, or a path in no data folder, is Git's to merge
 */
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineFolder, defineTable, field } from './contract.js';
import { formatDeclaration } from './declaration.js';
import { gitMergeKind, mergeForGit } from './merge-driver.js';
import { fileKindOf } from './merge-file.js';

const definition = defineFolder({
	kv: { a: field.number(), b: field.number(), c: field.number() },
	tables: {
		posts: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});
const ROW = fileKindOf(definition, 'posts/x.md');
const KV = fileKindOf(definition, 'kv.json');
const TEXT = fileKindOf(definition, 'notes.txt');

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (content: Uint8Array) => new TextDecoder().decode(content);
const row = (title: string, done: boolean, body = 'body\n') =>
	`---\ntitle: ${title}\ndone: ${done}\n---\n${body}`;
const merge = (
	kind: Parameters<typeof mergeForGit>[0],
	base: string,
	ours: string,
	theirs: string,
) =>
	mergeForGit(kind, {
		base: bytes(base),
		ours: bytes(ours),
		theirs: bytes(theirs),
	});

test('different fields of one row merge', async () => {
	const merged = await merge(
		ROW,
		row('Base', false),
		row('Base', true),
		row('Theirs', false),
	);
	expect(merged.kind).toBe('merged');
	if (merged.kind === 'merged')
		expect(text(merged.content)).toBe(row('Theirs', true));
});

test('one field both sides changed is marked on its own line', async () => {
	const merged = await merge(
		ROW,
		row('Base', false),
		row('Mine', true),
		row('Theirs', false),
	);
	expect(merged.kind).toBe('conflicted');
	if (merged.kind === 'conflicted')
		expect(text(merged.content)).toBe(
			'---\n<<<<<<< ours\ntitle: Mine\n=======\ntitle: Theirs\n>>>>>>> theirs\ndone: true\n---\nbody\n',
		);
});

test('kv.json keys added beside each other combine', async () => {
	const merged = await merge(
		KV,
		'{\n  "a": 1\n}\n',
		'{\n  "a": 1,\n  "b": 2\n}\n',
		'{\n  "a": 1,\n  "c": 3\n}\n',
	);
	expect(merged.kind).toBe('merged');
	if (merged.kind === 'merged')
		expect(JSON.parse(text(merged.content))).toEqual({ a: 1, b: 2, c: 3 });
});

test('one kv.json key both sides set is marked', async () => {
	const merged = await merge(
		KV,
		'{\n  "a": 1\n}\n',
		'{\n  "a": 2\n}\n',
		'{\n  "a": 3\n}\n',
	);
	expect(merged.kind).toBe('conflicted');
	if (merged.kind === 'conflicted')
		expect(text(merged.content)).toContain(
			'<<<<<<< ours\n  "a": 2\n=======\n  "a": 3\n>>>>>>> theirs\n',
		);
});

test('text edits to neighboring lines both merge', async () => {
	const merged = await merge(TEXT, 'a\nb\nc\n', 'A\nb\nc\n', 'a\nB\nc\n');
	expect(merged.kind).toBe('merged');
	if (merged.kind === 'merged') expect(text(merged.content)).toBe('A\nB\nc\n');
});

test('rows added on both sides merge by field from an empty base', async () => {
	const merged = await merge(
		ROW,
		'',
		row('Same', true),
		row('Same', true, 'other body\n'),
	);
	// The fields agree, and two bodies added at one place both stay.
	expect(merged.kind).toBe('merged');
	if (merged.kind === 'merged')
		expect(text(merged.content)).toBe(
			'---\ntitle: Same\ndone: true\n---\nbody\nother body\n',
		);
});

test('a version that is not text is left to Git', async () => {
	const merged = await mergeForGit(TEXT, {
		base: new Uint8Array([0, 1]),
		ours: new Uint8Array([0, 2]),
		theirs: new Uint8Array([0, 3]),
	});
	expect(merged.kind).toBe('git');
});

test('a path takes its kind from the nearest declaration above it', async () => {
	const top = await mkdtemp(join(tmpdir(), 'epicenter-merge-driver-'));
	try {
		await mkdir(join(top, 'vault'), { recursive: true });
		await writeFile(
			join(top, 'vault', 'epicenter.json'),
			formatDeclaration(definition),
		);
		expect(await gitMergeKind(top, 'vault/posts/x.md')).toMatchObject({
			kind: { kind: 'row' },
		});
		expect(await gitMergeKind(top, 'vault/kv.json')).toMatchObject({
			kind: { kind: 'kv' },
		});
		expect(await gitMergeKind(top, 'vault/notes.txt')).toEqual({
			kind: { kind: 'file' },
		});
		expect(await gitMergeKind(top, 'outside.txt')).toHaveProperty('reason');
		await writeFile(join(top, 'epicenter.json'), '{');
		expect(await gitMergeKind(top, 'outside.txt')).toHaveProperty('reason');
	} finally {
		await rm(top, { recursive: true, force: true });
	}
});

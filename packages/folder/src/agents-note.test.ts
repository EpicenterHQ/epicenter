/**
 * Root AGENTS.md note tests.
 *
 * Key behaviors:
 * - A new note names the published contract and its collection paths.
 * - Existing front matter and personal text survive block updates.
 * - A second update leaves the same bytes.
 */
import { expect, test } from 'bun:test';
import { defineContract } from '@epicenter/definition/contract';
import { withAgentsNote } from './agents-note.js';

const contract = defineContract({
	description: 'Notes and their attachments.',
	collections: {
		notes: { path: 'notes/{id}.md' },
		attachments: { path: 'attachments/{id}.{ext}' },
	},
});
const url = 'https://notes.example.com/contract.json';

test('a missing file gets front matter and a deterministic collection block', () => {
	const note = withAgentsNote(null, contract, url);
	expect(note).toStartWith(`---\ncontract: "${url}"\n---\n`);
	expect(note).toContain('Notes and their attachments.\nCollections:\n');
	expect(note).toContain('attachments: `attachments/{id}.{ext}`');
	expect(note).toContain('notes: `notes/{id}.md`');
	expect(note).toContain('Check edits with `epicenter check`.');
});

test('an existing file without markers gets a block after personal text', () => {
	const original = `---\ncontract: ${url}\nowner: me\n---\nKeep this advice.\n`;
	const note = withAgentsNote(original, contract, url);
	expect(note).toStartWith(original);
	expect(note).toContain('<!-- BEGIN epicenter -->');
});

test('an existing block changes in place and leaves personal text around it', () => {
	const original = `---\ncontract: ${url}\n---\nBefore.\n<!-- BEGIN epicenter -->  \nOld.\n<!-- END epicenter -->  \nAfter.\n`;
	const note = withAgentsNote(original, contract, url);
	expect(note).toStartWith(`---\ncontract: ${url}\n---\nBefore.\n`);
	expect(note).toContain('<!-- BEGIN epicenter -->  \n');
	expect(note).toEndWith('<!-- END epicenter -->  \nAfter.\n');
	expect(note).not.toContain('Old.');
});

test('a missing contract key is inserted without changing other front matter', () => {
	const note = withAgentsNote(
		'---\nowner: me\n---\nMy rules.\n',
		contract,
		url,
	);
	expect(note).toStartWith(
		`---\nowner: me\ncontract: "${url}"\n---\nMy rules.\n`,
	);
});

test('a quoted contract key counts as the existing key', () => {
	const note = withAgentsNote(
		'---\n"contract": https://another.example.com/contract.json\n---\n',
		contract,
		url,
	);
	expect(note).toStartWith(
		'---\n"contract": https://another.example.com/contract.json\n---\n',
	);
	expect(note).not.toContain(`contract: ${url}`);
});

test('running the transform twice produces identical text', () => {
	const once = withAgentsNote('My rules.\n', contract, url);
	expect(withAgentsNote(once, contract, url)).toBe(once);
});

test('a CRLF note with a BOM keeps its personal bytes and updates once', () => {
	const original =
		'\uFEFF---\r\nowner: me\r\n---\r\nBefore.\r\n<!-- BEGIN epicenter -->\r\nOld.\r\n<!-- END epicenter -->\r\nAfter.\r\n';
	const once = withAgentsNote(original, contract, url);
	expect(once).toStartWith(
		`\uFEFF---\r\nowner: me\r\ncontract: "${url}"\r\n---\r\nBefore.\r\n`,
	);
	expect(once).toEndWith('<!-- END epicenter -->\r\nAfter.\r\n');
	expect(withAgentsNote(once, contract, url)).toBe(once);
});

test('an unclosed managed block is refused without losing personal text', () => {
	expect(() =>
		withAgentsNote('<!-- BEGIN epicenter -->\nMy text.\n', contract, url),
	).toThrow('incomplete');
});

test('two managed blocks heal to one and keep text outside their span', () => {
	const original = `---\ncontract: "${url}"\n---\nBefore.\n<!-- BEGIN epicenter -->\nOld.\n<!-- END epicenter -->\n<<<<<<< ours\n<!-- BEGIN epicenter -->\nOther.\n<!-- END epicenter -->\nAfter.\n`;
	const healed = withAgentsNote(original, contract, url);
	expect(healed.match(/<!-- BEGIN epicenter -->/g)).toHaveLength(1);
	expect(healed.match(/<!-- END epicenter -->/g)).toHaveLength(1);
	expect(healed).toStartWith(`---\ncontract: "${url}"\n---\nBefore.\n`);
	expect(healed).toEndWith('<!-- END epicenter -->\nAfter.\n');
	expect(healed).not.toContain('<<<<<<<');
});

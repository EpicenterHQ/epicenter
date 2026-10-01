/**
 * The host's half of the working copy (ADR-0337).
 *
 * What is worth pinning: that a path cannot leave the folder, that a file is
 * never readable half-written, that a checkout is complete so what it does not
 * name goes, that a person's own files survive both directions, that a write
 * whose bytes already match does not touch the file, and that a write lands
 * only on the folder it was prepared against. Everything else about what a
 * file CONTAINS is the application's, because the host interprets nothing.
 */

import { expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST_PATH } from '@epicenter/app/artifact/checkout';
import {
	CheckoutPreconditionFailedError,
	checkoutFolderPath,
	readCheckout,
	writeCheckout,
} from './checkout.ts';

const ROOT = '/Users/person/Epicenter';
const APP = 'so.epicenter.honeycrisp';

const folder = (dataId: string) => checkoutFolderPath({ dataId, root: ROOT });

const file = (path: string, contents: string) =>
	`${JSON.stringify({ path, contents })}\n`;

function scratch(): string {
	return mkdtempSync(join(tmpdir(), 'epicenter-checkout-'));
}

/**
 * Write the folder against the reading it has right now.
 *
 * What the library does on every push and pull, and what every test below
 * means when it writes: the `If-Match` is not a detail of the call, it is the
 * statement that this write was prepared against the folder as it stands.
 */
async function write(target: string, ndjson: string): Promise<void> {
	const { etag } = await readCheckout(target);
	await writeCheckout(target, ndjson, etag);
}

/** The bytes of a reading, for a test that only cares what is in the folder. */
async function read(target: string): Promise<string> {
	return (await readCheckout(target)).ndjson;
}

function paths(ndjson: string): string[] {
	return ndjson
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => (JSON.parse(line) as { path: string }).path)
		.sort();
}

test('a folder is the data id, one segment under the root', () => {
	// And nothing under that. The `local`/`account` segment went with the device
	// store: there is one store per data id, so there is one folder.
	expect(folder(APP)).toBe(`${ROOT}/${APP}`);
});

test('a data id that could not name an app directory is refused', () => {
	expect(folder('..')).toBeUndefined();
	expect(folder('.')).toBeUndefined();
	expect(folder('')).toBeUndefined();
	expect(folder('a/b')).toBeUndefined();
});

test('a file cannot climb out of its folder', async () => {
	const root = scratch();
	const target = join(root, APP);
	// `../x.md` and `./x.md` both SPLIT into two segments, so a grammar check
	// alone admits them. Containment is what actually refuses them.
	await write(
		target,
		file('../escape.md', 'no') +
			file('./escape.md', 'no') +
			file('/etc/passwd', 'no') +
			file('notes/../../escape.md', 'no') +
			file('notes/ok.md', 'yes'),
	);
	expect(readdirSync(root)).toEqual([APP]);
	expect(readFileSync(join(target, 'notes/ok.md'), 'utf8')).toBe('yes');
});

test('a checkout is complete, so what it does not name is gone', async () => {
	const target = join(scratch(), APP);
	await write(
		target,
		file('notes/a.md', 'a') + file('notes/b.md', 'b') + file('kv.json', '{}'),
	);
	await write(target, file('notes/a.md', 'a2') + file('kv.json', '{}'));

	expect(readFileSync(join(target, 'notes/a.md'), 'utf8')).toBe('a2');
	expect(readdirSync(join(target, 'notes'))).toEqual(['a.md']);
});

test("a person's own files survive a checkout, and are never handed back", async () => {
	// The folder root is also where somebody puts a note to themselves. The
	// `AGENTS.md` a pull generates is not one of those: it is the store's file,
	// swept like the rest, and its own first line says so.
	const target = join(scratch(), APP);
	await write(target, file('notes/a.md', 'a'));
	writeFileSync(join(target, 'README.md'), 'mine');
	mkdirSync(join(target, 'scratch'));
	writeFileSync(join(target, 'scratch/idea.txt'), 'also mine');

	await write(target, file('notes/b.md', 'b'));
	expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('mine');
	expect(readFileSync(join(target, 'scratch/idea.txt'), 'utf8')).toBe(
		'also mine',
	);
	expect(paths(await read(target))).toEqual(['notes/b.md']);
});

test("the store's own files are swept, and a person's are not", async () => {
	const target = join(scratch(), APP);
	await write(target, file('AGENTS.md', 'generated') + file('notes/a.md', 'a'));
	writeFileSync(join(target, 'NOTES.md'), 'mine');

	await write(target, file('notes/a.md', 'a'));
	expect(readFileSync(join(target, 'NOTES.md'), 'utf8')).toBe('mine');
	expect(readdirSync(target).sort()).toEqual(['NOTES.md', 'notes']);
});

test('the manifest is written and read like any other file, and never parsed', async () => {
	const target = join(scratch(), APP);
	// Deliberately not valid JSON. The host has no opinion about what is in a
	// file: whether this manifest can be read is the application's question.
	await write(
		target,
		file('.epicenter/manifest.json', 'not json') + file('notes/a.md', 'a'),
	);
	expect(paths(await read(target))).toEqual([
		'.epicenter/manifest.json',
		'notes/a.md',
	]);
});

test('a write whose bytes already match does not touch the file', async () => {
	// A rename replaces the inode, so rewriting an unchanged file makes Time
	// Machine, rclone, and Spotlight see the whole folder as new every pull.
	const target = join(scratch(), APP);
	await write(target, file('notes/a.md', 'a'));
	const before = statSync(join(target, 'notes/a.md'));

	await Bun.sleep(10);
	await write(target, file('notes/a.md', 'a'));
	const after = statSync(join(target, 'notes/a.md'));
	expect(after.mtimeMs).toBe(before.mtimeMs);
});

test('reading a folder that was never pulled answers empty rather than failing', async () => {
	// A place with no checkout has no stale files by definition, and asking is
	// how `pull` learns the folder is clean on a fresh machine.
	expect(await read(join(scratch(), APP))).toBe('');
});

test('an interrupted checkout leaves the manifest describing the previous one', async () => {
	// The order is the recovery. A directory where the next checkout wants a
	// file makes the write throw partway; the manifest is written last, so what
	// survives describes the checkout BEFORE this one and the next `pull`
	// compares against it, calls the folder dirty, and shows a person what is
	// there.
	const target = join(scratch(), APP);
	await write(
		target,
		file('notes/a.md', 'a') + file(MANIFEST_PATH, '{"generation":1}'),
	);
	mkdirSync(join(target, 'notes/b.md'));

	await expect(
		write(
			target,
			file('notes/b.md', 'b') + file(MANIFEST_PATH, '{"generation":2}'),
		),
	).rejects.toThrow();
	expect(readFileSync(join(target, MANIFEST_PATH), 'utf8')).toBe(
		'{"generation":1}',
	);
});

test('a folder is the only thing a checkout leaves under the root', async () => {
	// There is no lock home beside it any more. Exclusion is a promise chain in
	// this process, which is the only process that owns this root, so nothing on
	// disk can outlive the process that took it.
	const root = scratch();
	await write(join(root, APP), file('notes/a.md', 'a'));
	expect(readdirSync(root)).toEqual([APP]);
});

test('a write prepared against another reading is refused, and changes nothing', async () => {
	const target = join(scratch(), APP);
	await write(target, file('notes/a.md', 'a'));
	const stale = (await readCheckout(target)).etag;

	// Somebody edits the folder between the reading and the write.
	writeFileSync(join(target, 'notes/a.md'), 'edited by hand');

	await expect(
		writeCheckout(target, file('notes/a.md', 'a'), stale),
	).rejects.toBeInstanceOf(CheckoutPreconditionFailedError);
	expect(readFileSync(join(target, 'notes/a.md'), 'utf8')).toBe(
		'edited by hand',
	);
});

test("a person's own file changing does not invalidate a reading", async () => {
	// The digest covers what a checkout is responsible for and nothing else, so
	// somebody saving their own `README.md` while a pull dialog is open does not
	// refuse the pull.
	const target = join(scratch(), APP);
	await write(target, file('notes/a.md', 'a'));
	const etag = (await readCheckout(target)).etag;
	writeFileSync(join(target, 'README.md'), 'mine');

	await writeCheckout(target, file('notes/a.md', 'a2'), etag);
	expect(readFileSync(join(target, 'notes/a.md'), 'utf8')).toBe('a2');
});

test('a read never catches a folder half-replaced', async () => {
	// Per-file rename is atomic; the SET of files is not. Both verbs run in one
	// chain per folder, so a reading is always of a folder that settled.
	const target = join(scratch(), APP);
	await write(target, file('notes/a.md', 'a') + file('notes/b.md', 'b'));
	const etag = (await readCheckout(target)).etag;

	const writing = writeCheckout(
		target,
		file('notes/c.md', 'c') + file('notes/d.md', 'd'),
		etag,
	);
	const during = readCheckout(target);
	await writing;

	expect(paths((await during).ndjson)).toEqual(['notes/c.md', 'notes/d.md']);
});

test('one write failing does not poison the next request for that folder', async () => {
	const target = join(scratch(), APP);
	await write(target, file('notes/a.md', 'a'));

	await expect(
		writeCheckout(target, file('notes/a.md', 'a'), '"not the folder"'),
	).rejects.toBeInstanceOf(CheckoutPreconditionFailedError);

	await write(target, file('notes/b.md', 'b'));
	expect(paths(await read(target))).toEqual(['notes/b.md']);
});

/**
 * The new verbs through the real CLI: `query` over a seeded mirror, the
 * `recategorize` read-only refusal (the precondition that replaced the old
 * capability lattice's read-only mode), and `demo` building a sample company.
 * Driving the binary proves argv parsing, realm resolution, and exit codes, not
 * just the cores (covered in src/books/*.test.ts).
 */

import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { booksDbFile, openBooksDb } from '../src/db.ts';
import { tempRoot } from './helpers.ts';

const BIN = join(import.meta.dir, '../src/bin.ts');

async function runCli(args: string[], env: Record<string, string> = {}) {
	const proc = Bun.spawn([process.execPath, BIN, ...args], {
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

/** Seed the r1 company's current mirror artifact with one live invoice. */
function seedMirror(dir: string): void {
	const db = openBooksDb(booksDbFile(dir, 'r1'));
	// The schema exists at open (MIRROR_SCHEMA); doc_number/total_amt project
	// from the blob.
	db.raw.exec(`
		INSERT INTO invoices (id, raw, synced_at, deleted) VALUES
			('1', '{"Id":"1","DocNumber":"INV-1","TotalAmt":8000.0}', '2026-01-01', 0);
	`);
	db.close();
}

test('CLI: `query` returns mirror rows as JSON', async () => {
	const tmp = tempRoot();
	seedMirror(tmp.appDir);
	const res = await runCli(
		[
			'query',
			'--realm',
			'r1',
			'SELECT doc_number, total_amt FROM invoices WHERE deleted = 0',
		],
		{ EPICENTER_DATA_DIR: tmp.root },
	);
	expect(res.exitCode).toBe(0);
	const rows = JSON.parse(res.stdout);
	expect(rows).toEqual([{ doc_number: 'INV-1', total_amt: 8000 }]);
	tmp.cleanup();
});

test('CLI: `recategorize` is refused under LOCAL_BOOKS_READ_ONLY', async () => {
	const tmp = tempRoot();
	const res = await runCli(
		['recategorize', 'Purchase', 'p1', '--to', '61', '--realm', 'r1'],
		{ EPICENTER_DATA_DIR: tmp.root, LOCAL_BOOKS_READ_ONLY: '1' },
	);
	expect(res.exitCode).toBe(1);
	expect(res.stderr).toContain('Refusing to write');
	tmp.cleanup();
});

test('CLI: `demo` builds a sample company and prints example answers', async () => {
	const tmp = tempRoot();
	const res = await runCli(['demo'], { EPICENTER_DATA_DIR: tmp.root });
	expect(res.exitCode).toBe(0);
	expect(res.stdout).toContain('sample company');
	expect(res.stdout).toContain('Who owes us money');
	expect(existsSync(booksDbFile(tmp.appDir, 'demo').path)).toBe(true);
	tmp.cleanup();
});

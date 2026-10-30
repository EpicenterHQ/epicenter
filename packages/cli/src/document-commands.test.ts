/**
 * Desktop SQL CLI boundary tests use fresh processes and ordinary files.
 * Schema-free reads leave disk unchanged; malformed input and writes return
 * machine-readable refusals. Desktop result limits do not alter public query.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const command = process.env.EPICENTER_BIN
	? [resolve(process.env.EPICENTER_BIN)]
	: [process.execPath, '--no-install', resolve(import.meta.dir, 'bin.ts')];

test('desktop SQL reads without creating a declaration or repository and refuses malformed or mutating requests', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-document-cli-'));
	const source = '# Plain Markdown\n';
	await writeFile(join(directory, 'a.md'), source);
	const run = (input: string) =>
		Bun.spawnSync([...command, 'documents-query', directory, '--json'], {
			stdin: new TextEncoder().encode(input),
			stdout: 'pipe',
			stderr: 'pipe',
		});
	try {
		const answer = run(
			JSON.stringify({ sql: 'SELECT path, body FROM documents' }),
		);
		expect(answer.exitCode).toBe(0);
		expect(JSON.parse(answer.stdout.toString())).toMatchObject({
			rows: [{ path: 'a.md', body: source }],
			warnings: [],
			truncated: false,
		});
		for (const input of [
			'{',
			'{}',
			JSON.stringify({ sql: 'DELETE FROM documents' }),
		]) {
			const refused = run(input);
			expect(refused.exitCode).toBe(2);
			expect(JSON.parse(refused.stdout.toString())).toHaveProperty('error');
		}
		expect(await readdir(directory)).toEqual(['a.md']);
		expect(await readFile(join(directory, 'a.md'), 'utf8')).toBe(source);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

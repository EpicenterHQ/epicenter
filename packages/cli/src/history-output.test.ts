/**
 * Human sync replies through the public command boundary.
 * A child process isolates module mocks from real Git integration tests. The
 * command must distinguish sent versions, later local changes, and send failures.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HistoryResults } from '@epicenter/folder/bun';

const head = 'a'.repeat(40),
	sent = 'b'.repeat(40);
const cases = [
	{ outcome: { kind: 'synced', head }, text: 'Synced at aaaaaaa.' },
	{
		outcome: {
			kind: 'saved',
			head,
			push: { status: 'pushed', oid: sent },
			changedSince: false,
		},
		text: 'Saved at aaaaaaa; sent bbbbbbb; this folder has moved on since.',
	},
	{
		outcome: {
			kind: 'saved',
			head,
			push: { status: 'pushed', oid: head },
			changedSince: true,
		},
		text: 'Saved at aaaaaaa; local files changed since that version; sent aaaaaaa.',
	},
	{
		outcome: { kind: 'saved', head, push: undefined, changedSince: true },
		text: 'Saved at aaaaaaa; local files changed since that version.',
	},
	{
		outcome: {
			kind: 'saved',
			head,
			push: { status: 'failed', oid: head, error: 'offline' },
			changedSince: false,
		},
		text: 'Saved at aaaaaaa; sending was not confirmed: offline.',
	},
	{
		outcome: {
			kind: 'saved',
			head,
			push: { status: 'cancelled', oid: head },
			changedSince: false,
		},
		text: 'Saved at aaaaaaa; sending was cancelled.',
	},
	{
		outcome: {
			kind: 'saved',
			head: undefined,
			push: undefined,
			changedSince: false,
		},
		text: 'Saved at none; no version was sent.',
	},
] satisfies {
	outcome: NonNullable<HistoryResults['sync']['data']>;
	text: string;
}[];

test('sync output reports the actual publication and change receipts', async () => {
	const scratch = await mkdtemp(join(tmpdir(), 'history-output-'));
	const folderModule = Bun.resolveSync(
		'@epicenter/folder/bun',
		import.meta.dir,
	);
	const script = join(scratch, 'command.mjs');
	await writeFile(
		script,
		`import { mock } from 'bun:test';
const original = { ...(await import(${JSON.stringify(folderModule)})) };
const replies = ${JSON.stringify(cases.map(({ outcome }) => ({ result: { data: outcome, error: null }, state: { branch: 'main' }, landed: [] })))};
mock.module(${JSON.stringify(folderModule)}, () => ({ ...original, runHistory: async () => replies.shift() }));
const { historyCommand } = await import(${JSON.stringify(join(import.meta.dir, 'history-commands.ts'))});
for (let i = 0; i < ${cases.length}; i++) {
 const code = await historyCommand('sync', ${JSON.stringify(scratch)}, {}, false, 'device');
 if (code !== 0) throw new Error('Unexpected failure exit code: ' + code);
}
`,
	);
	try {
		const child = Bun.spawn([process.execPath, '--no-install', script], {
			env: {
				PATH: process.env.PATH,
				EPICENTER_FOLDER_DIR: join(scratch, 'library'),
				EPICENTER_DATA_DIR: join(scratch, 'data'),
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, stderr).toBe(0);
		expect(stdout.trim().split('\n')).toEqual(cases.map((item) => item.text));
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});

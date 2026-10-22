/**
 * Ordinary connection-row commands await their actual publication before
 * answering, but do not defer a stop signal to finish that save. Each child
 * runs the real command and Folder engine, with a gate immediately before
 * its table write. Auth-refresh token persistence keeps its separate protection.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function pausedCommand() {
	const scratch = await mkdtemp(join(tmpdir(), 'connection-row-stop-'));
	cleanups.push(() => rm(scratch, { recursive: true, force: true }));
	const gate = join(scratch, 'release');
	const root = join(scratch, 'library');
	const script = join(scratch, 'command.mjs');
	const folderModule = Bun.resolveSync(
		'@epicenter/folder/bun',
		import.meta.dir,
	);
	await writeFile(
		script,
		`import { mock } from 'bun:test';
import { existsSync } from 'node:fs';
const original = { ...(await import(${JSON.stringify(folderModule)})) };
mock.module(${JSON.stringify(folderModule)}, () => ({
	...original,
	async openFolder(options) {
		const opened = await original.openFolder(options);
		if (opened.error !== null) return opened;
		const folder = opened.data;
		return { error: null, data: {
			...folder,
			tables: { ...folder.tables, connections: {
				...folder.tables.connections,
				async write(...args) {
					process.stderr.write('SAVE_READY\\n');
					while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(1);
					return folder.tables.connections.write(...args);
				},
			} },
		} };
	},
}));
await import(${JSON.stringify(join(import.meta.dir, 'bin.ts'))});
`,
	);
	const child = Bun.spawn(
		[
			process.execPath,
			'--no-install',
			script,
			'whispering-connection',
			'set',
			'text',
			'--json',
		],
		{
			env: {
				PATH: process.env.PATH,
				EPICENTER_FOLDER_DIR: root,
				EPICENTER_DATA_DIR: join(scratch, 'data'),
			},
			stdin: new TextEncoder().encode(
				JSON.stringify({
					fields: {
						kind: 'openai-compatible',
						title: 'Awaited connection',
						model: 'awaited',
					},
				}),
			),
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	cleanups.push(async () => {
		if (child.exitCode === null) child.kill('SIGKILL');
		await child.exited;
	});
	const output = new Response(child.stdout).text();
	const reader = child.stderr.getReader();
	let diagnostic = '';
	try {
		const decoder = new TextDecoder();
		while (!diagnostic.includes('SAVE_READY\n')) {
			const chunk = await reader.read();
			if (chunk.done)
				throw new Error(`Command ended before saving: ${diagnostic}`);
			diagnostic += decoder.decode(chunk.value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
	return {
		child,
		output,
		rowFile: join(root, 'so.epicenter', 'connections', 'whispering-text.md'),
		release: () => writeFile(gate, ''),
	};
}

test('an ordinary connection command answers only after its save is published', async () => {
	const command = await pausedCommand();
	expect(existsSync(command.rowFile)).toBe(false);
	await command.release();
	expect(await command.child.exited).toBe(0);
	const saved = await readFile(command.rowFile, 'utf8');
	expect(saved).toContain('model: awaited');
	expect(JSON.parse(await command.output).row.text).toBe(saved);
});

test('a stopped connection command does not finish its pending ordinary save', async () => {
	const command = await pausedCommand();
	command.child.kill('SIGTERM');
	await command.release();
	expect(await command.child.exited).toBe(143);
	expect(await command.output).toBe('');
	expect(existsSync(command.rowFile)).toBe(false);
});

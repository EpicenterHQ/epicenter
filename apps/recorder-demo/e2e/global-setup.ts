/**
 * Start `stack.ts` (Bun) for the whole run, and stop it after. The tests
 * find what it started in the file `RECORDER_DEMO_E2E_STATE` names.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default async function globalSetup() {
	const directory = mkdtempSync(join(tmpdir(), 'recorder-demo-state-'));
	const state = join(directory, 'stack.json');
	const stack = spawn(
		'bun',
		['--no-install', join(import.meta.dirname, 'stack.ts'), state],
		{ stdio: ['ignore', 'pipe', 'inherit'] },
	);
	await new Promise<void>((ready, failed) => {
		let output = '';
		stack.stdout.on('data', (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes('ready')) ready();
		});
		stack.on('exit', (code) =>
			failed(new Error(`The e2e stack exited ${code} before it was ready`)),
		);
	});
	process.env.RECORDER_DEMO_E2E_STATE = state;
	return async () => {
		stack.kill('SIGTERM');
		await new Promise((done) => stack.once('exit', done));
		await rm(directory, { recursive: true, force: true });
	};
}

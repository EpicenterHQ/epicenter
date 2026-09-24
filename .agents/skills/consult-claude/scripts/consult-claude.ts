#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

async function main() {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			resume: { type: 'string' },
			model: { type: 'string', default: 'claude-fable-5-1' },
			'dry-run': { type: 'boolean', default: false },
		},
	});
	if (!values.model.trim()) throw new Error('Model must not be empty.');
	if (values.resume !== undefined && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(values.resume)) {
		throw new Error('Resume requires the full native session_id from a prior consultation.');
	}
	const brief = await Bun.stdin.text();
	if (!brief.trim()) throw new Error('Consultation brief is empty.');
	const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
	if (git.error) throw git.error;
	if (git.status !== 0) throw new Error(git.stderr.trim());
	const cwd = git.stdout.trim();
	const args = [
		'--print', '--output-format', 'json',
		'--restricted', '--tools', 'Read,Glob,Grep',
		'--disallowedTools', 'mcp__*', '--strict-mcp-config',
		'--permission-mode', 'dontAsk',
		'--settings', JSON.stringify({
			disableAllHooks: true,
			permissions: { blockReadsOutsideWorkingDirectories: true },
		}),
		'--model', values.model,
		'--append-system-prompt',
		'You are Codex\'s read-only consultant. Return findings or specific evidence requests in this conversation. Codex owns edits, tests, benchmarks, and integration. If asked to apply adversarial-review, you are already the delegated reviewer: perform it yourself and launch no child agents.',
		...(values.resume ? ['--resume', values.resume] : []),
	];
	if (values['dry-run']) {
		console.log(JSON.stringify({ cwd, args }, null, 2));
		return;
	}
	// Stream native JSON and diagnostics without owning another session format.
	const child = Bun.spawn(['claude', ...args], {
		cwd,
		stdin: new Blob([brief]),
		stdout: 'inherit',
		stderr: 'inherit',
	});
	process.exitCode = await child.exited;
}

await main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});

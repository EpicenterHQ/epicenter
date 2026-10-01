#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

async function main() {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			resume: { type: 'string' },
			mode: { type: 'string', default: 'consult' },
			workspace: { type: 'string' },
			model: { type: 'string', default: 'claude-opus-5-5' },
			effort: { type: 'string' },
			'dry-run': { type: 'boolean', default: false },
		},
	});
	if (!['consult', 'delegate'].includes(values.mode))
		throw new Error('Mode must be consult or delegate.');
	if (values.mode === 'consult' && values.workspace !== undefined)
		throw new Error(
			'--workspace belongs to delegate mode; run consultation from its source checkout.',
		);
	if (values.mode === 'delegate' && !values.workspace?.trim())
		throw new Error(
			'Delegation requires --workspace pointing to a dedicated clone.',
		);
	if (!values.model.trim()) throw new Error('Model must not be empty.');
	if (values.effort !== undefined && !values.effort.trim())
		throw new Error('Effort must not be empty.');
	if (
		values.resume !== undefined &&
		!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(values.resume)
	) {
		throw new Error(
			'Resume requires the full native session_id from a prior consultation.',
		);
	}
	const brief = await Bun.stdin.text();
	if (!brief.trim()) throw new Error('Consultation brief is empty.');
	const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
		encoding: 'utf8',
	});
	if (git.error) throw git.error;
	if (git.status !== 0) throw new Error(git.stderr.trim());
	const source = realpathSync(git.stdout.trim());
	const delegating = values.mode === 'delegate';
	const cwd = delegating ? realpathSync(resolve(values.workspace!)) : source;
	if (delegating) {
		const inside = relative(source, cwd);
		const ancestor = relative(cwd, source);
		if (
			inside === '' ||
			(inside !== '..' && !inside.startsWith('../') && !isAbsolute(inside)) ||
			(ancestor !== '..' &&
				!ancestor.startsWith('../') &&
				!isAbsolute(ancestor))
		)
			throw new Error(
				'Delegate workspace must be outside the coordinating checkout.',
			);
		const target = spawnSync(
			'git',
			['rev-parse', '--show-toplevel', '--git-common-dir'],
			{
				cwd,
				encoding: 'utf8',
			},
		);
		if (target.error) throw target.error;
		if (target.status !== 0)
			throw new Error('Delegate workspace must be a Git clone.');
		const [root, common] = target.stdout.trim().split('\n');
		if (
			realpathSync(root!) !== cwd ||
			realpathSync(resolve(cwd, common!)) !== resolve(cwd, '.git')
		)
			throw new Error(
				'Delegate workspace must be the root of a standalone clone, not a shared worktree.',
			);
	}
	const settings = {
		disableAllHooks: true,
		permissions: { blockReadsOutsideWorkingDirectories: true },
		...(delegating
			? {
					sandbox: {
						enabled: true,
						failIfUnavailable: true,
						autoAllowBashIfSandboxed: true,
						allowUnsandboxedCommands: false,
						excludedCommands: [],
						filesystem: { disabled: false },
						network: { allowedDomains: [], allowLocalBinding: false },
					},
				}
			: {}),
	};
	const args = [
		'--print',
		'--output-format',
		'json',
		'--restricted',
		'--tools',
		delegating ? 'Read,Glob,Grep,Edit,Write,Bash' : 'Read,Glob,Grep',
		...(delegating ? ['--allowedTools', 'Read,Glob,Grep,Edit,Write'] : []),
		'--disallowedTools',
		'mcp__*',
		'--strict-mcp-config',
		'--permission-mode',
		'dontAsk',
		'--settings',
		JSON.stringify(settings),
		'--model',
		values.model,
		...(values.effort ? ['--effort', values.effort] : []),
		'--append-system-prompt',
		delegating
			? "You own the bounded assignment in this dedicated clone. Read AGENTS.md and applicable skills. Implement and run relevant checks within the brief's scope. Do not launch child agents, commit, push, publish, deploy, alter remotes, or change access settings. Stop on missing requirements or blocked access and return concrete partial work. Return the artifact or changed paths, verification commands and results, and unresolved issues. Codex owns acceptance and integration into the live checkout."
			: "You are Codex's read-only consultant. Own the requested investigation, recommendation, or text draft. Return the finished answer, source evidence, and unresolved issues or specific evidence requests. Codex owns edits, tests, benchmarks, and integration. If asked to apply adversarial-review, you are already the delegated reviewer: perform it yourself and launch no child agents.",
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

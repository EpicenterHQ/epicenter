#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

function run(
	command: string,
	args: readonly string[],
	cwd: string,
	input?: string,
) {
	const result = spawnSync(command, args, { cwd, input, encoding: 'utf8' });
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			result.stderr.trim() || `${command} exited ${result.status}`,
		);
	return result.stdout;
}

async function copyUntracked(
	sourcePath: string,
	replicaPath: string,
	paths: readonly string[],
) {
	for (const path of paths) {
		if (path.startsWith('../') || path.startsWith('/'))
			throw new Error(`Unsafe untracked path from git: ${path}`);
		const source = join(sourcePath, path);
		if ((await lstat(source)).isDirectory())
			throw new Error(
				`Untracked directory cannot be snapshotted: ${path}. Ignore it or move it outside the source repository before consulting.`,
			);
		const destination = join(replicaPath, path);
		await mkdir(dirname(destination), { recursive: true });
		await cp(source, destination, {
			dereference: false,
			verbatimSymlinks: true,
			preserveTimestamps: true,
		});
	}
}

async function createSnapshot(sourcePath: string, replicaPath: string) {
	const head = run('git', ['rev-parse', 'HEAD'], sourcePath).trim();
	const patchPath = join(dirname(replicaPath), 'changes.patch');
	run('git', ['diff', '--binary', head, `--output=${patchPath}`], sourcePath);
	const untracked = run(
		'git',
		['ls-files', '--others', '--exclude-standard', '-z'],
		sourcePath,
	)
		.split('\0')
		.filter(Boolean);
	run('git', ['clone', '--no-local', sourcePath, replicaPath], sourcePath);
	run('git', ['remote', 'remove', 'origin'], replicaPath);
	run('git', ['checkout', '--detach', head], replicaPath);
	run('git', ['apply', '--allow-empty', '--index', patchPath], replicaPath);
	await copyUntracked(sourcePath, replicaPath, untracked);
	if (untracked.length)
		run(
			'git',
			[
				'--literal-pathspecs',
				'add',
				'--pathspec-from-file=-',
				'--pathspec-file-nul',
			],
			replicaPath,
			`${untracked.join('\0')}\0`,
		);
	const snapshotId = run('git', ['write-tree'], replicaPath).trim();
	run(
		'git',
		['update-ref', 'refs/consultation/baseline', snapshotId],
		replicaPath,
	);
	return snapshotId;
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	if (command !== 'start') {
		throw new Error(
			'Usage: consult-claude.ts start [--name <name>] [--model <alias-or-id>] [--dry-run]. Use claude agents, logs, and attach for an existing session.',
		);
	}
	const { values } = parseArgs({
		args,
		options: {
			name: { type: 'string', default: `research-${Date.now().toString(36)}` },
			model: { type: 'string', default: 'claude-fable-5-1' },
			'dry-run': { type: 'boolean', default: false },
		},
	});
	const id = values.name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
	if (!id) throw new Error('Run name must contain a letter or number.');
	if (!values.model.trim())
		throw new Error('Model must be an alias or model ID.');
	const mission = (await Bun.stdin.text()).trim();
	if (!mission) throw new Error('Research brief is empty.');
	const sourcePath = run(
		'git',
		['rev-parse', '--show-toplevel'],
		process.cwd(),
	).trim();
	const root =
		process.env.CLAUDE_RESEARCH_ROOT ??
		join(homedir(), '.cache', 'codex-claude-research');
	const runPath = join(root, id);
	const replicaPath = join(runPath, 'replica');
	const record = {
		id,
		mission,
		model: values.model,
		sourcePath,
		replicaPath,
		snapshotId: 'pending',
		checkpointPath: join(replicaPath, '.claude-research', 'checkpoint.md'),
		startedAt: new Date().toISOString(),
	};
	const settings = {
		permissions: {
			deny: ['Agent', 'AskUserQuestion', 'WebFetch'],
			blockReadsOutsideWorkingDirectories: true,
		},
		sandbox: {
			enabled: true,
			failIfUnavailable: true,
			allowUnsandboxedCommands: false,
			network: { allowedDomains: [], strictAllowlist: true },
		},
		// The independent clone is already the session's editing directory.
		worktree: { bgIsolation: 'none' },
	};
	if (values['dry-run']) {
		console.log(JSON.stringify({ ...record, settings }, null, 2));
		return;
	}
	await mkdir(root, { recursive: true });
	await mkdir(runPath); // Refuse an existing run without replacing its evidence.
	record.snapshotId = await createSnapshot(sourcePath, replicaPath);
	await mkdir(dirname(record.checkpointPath), { recursive: true });
	await writeFile(
		join(runPath, 'run.json'),
		`${JSON.stringify(record, null, 2)}\n`,
	);
	await writeFile(
		join(runPath, 'settings.json'),
		`${JSON.stringify(settings, null, 2)}\n`,
	);
	console.log(JSON.stringify(record, null, 2));
	const instructions = `You own an editable repository snapshot ${record.snapshotId} at ${replicaPath}.
Research, edit, and run tests inside this laboratory. Restricted Git operations may require approval.
Codex owns the living checkout and decides which findings to integrate.
Follow evidence and try to disprove your theory. Cite baseline claims as path:line@${record.snapshotId}; Git preserves that tree at refs/consultation/baseline. Describe experimental changes separately.
WebSearch may inform research. Direct fetches, shell network access, and external actions are outside this consultation.
Ignored dependencies are absent from the snapshot. Report checks you cannot run; do not reach into the living checkout for them.
Keep a research report at ${record.checkpointPath}, with findings, evidence, checks run, and open questions.
Update it before asking for a decision and before finishing. The report is evidence; native session state owns progress.
Respond in this conversation when you need a decision or have completed the outcome.`;
	process.stdout.write(
		run(
			'claude',
			[
				'--restricted',
				'--model',
				values.model,
				'--name',
				id,
				'--append-system-prompt',
				instructions,
				'--tools',
				'Bash,Read,Glob,Grep,Edit,Write,NotebookEdit,WebSearch',
				'--effort',
				'high',
				'--settings',
				join(runPath, 'settings.json'),
				'--strict-mcp-config',
				'--permission-mode',
				'auto',
				'--bg',
				mission,
			],
			replicaPath,
		),
	);
}

await main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});

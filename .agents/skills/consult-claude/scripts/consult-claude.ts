#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
	assertDelegateWorkspace,
	resolveSkillWriteRoots,
} from './workspace.js';

async function main() {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			resume: { type: 'string' },
			mode: { type: 'string', default: 'consult' },
			workspace: { type: 'string' },
			model: { type: 'string' },
			effort: { type: 'string' },
			account: { type: 'string' },
			'account-email': { type: 'string' },
			codex: { type: 'boolean', default: false },
			'codex-model': { type: 'string' },
			'codex-max-calls': { type: 'string' },
			'codex-timeout-ms': { type: 'string' },
			'codex-write-root': { type: 'string', multiple: true },
			'dry-run': { type: 'boolean', default: false },
		},
	});
	if (values.account !== 'personal' && values.account !== 'work')
		throw new Error('--account must be personal or work.');
	const expectedEmail = values['account-email']?.trim();
	if (!expectedEmail)
		throw new Error('--account-email must be the verified Claude email.');
	if (!['consult', 'delegate'].includes(values.mode))
		throw new Error('Mode must be consult or delegate.');
	if (values.mode === 'consult' && values.workspace !== undefined)
		throw new Error(
			'--workspace belongs to delegate mode; run consultation from its source checkout.',
		);
	if (values.workspace !== undefined && !values.workspace.trim())
		throw new Error('Workspace must not be empty.');
	if (values.model !== undefined && !values.model.trim())
		throw new Error('Model must not be empty.');
	if (values.effort !== undefined && !values.effort.trim())
		throw new Error('Effort must not be empty.');
	if (values.codex && !values['codex-model']?.trim())
		throw new Error('--codex requires an explicit --codex-model.');
	if (values.codex) {
		try {
			Bun.resolveSync(
				'@modelcontextprotocol/sdk/server/index.js',
				import.meta.dir,
			);
		} catch {
			throw new Error(
				'Install Codex assistance dependencies with bun install --ignore-scripts --cwd .agents/skills/consult-claude.',
			);
		}
	}
	for (const name of [
		'codex-model',
		'codex-max-calls',
		'codex-timeout-ms',
	] as const) {
		if (!values.codex && values[name] !== undefined)
			throw new Error(`--${name} requires --codex.`);
		if (
			name !== 'codex-model' &&
			values[name] !== undefined &&
			(!Number.isSafeInteger(Number(values[name])) || Number(values[name]) < 1)
		)
			throw new Error(`--${name} must be a positive integer.`);
	}
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
	if (values['codex-write-root'] && (!delegating || !values.codex))
		throw new Error('--codex-write-root requires helper-backed delegate mode.');
	// Apply the preferred reasoning lead on new and resumed sessions. Native
	// resume retains conversation history even when the selected model changes.
	const model = values.model ?? 'claude-opus-5-5';
	const effort = values.effort ?? 'high';
	const cwd =
		delegating && values.workspace
			? realpathSync(resolve(values.workspace))
			: source;
	if (delegating) assertDelegateWorkspace(source, cwd);
	const skillWriteRoots = resolveSkillWriteRoots(
		cwd,
		values['codex-write-root'] ?? [],
	);
	const directExecution = delegating && !values.codex;
	const settings = {
		disableAllHooks: true,
		permissions: { blockReadsOutsideWorkingDirectories: true },
		...(directExecution
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
	// Native Claude owns credentials and refresh. Personal preserves the existing
	// unset/default Keychain service; explicitly setting ~/.claude is a different login.
	const env = { ...process.env };
	const removedEnv: string[] = [];
	const configDirectory = join(
		homedir(),
		values.account === 'personal' ? '.claude' : '.claude-work',
	);
	for (const key of Object.keys(env)) {
		if (
			key.startsWith('ANTHROPIC_') ||
			key.startsWith('CLAUDE_CODE_USE_') ||
			key.startsWith('CLAUDE_CODE_OAUTH_') ||
			[
				'CLAUDE_CONFIG_DIR',
				'CLAUDE_SECURESTORAGE_CONFIG_DIR',
				'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
				'CLAUDE_CODE_SIMPLE',
				'AWS_BEARER_TOKEN_BEDROCK',
			].includes(key)
		) {
			removedEnv.push(key);
			delete env[key];
		}
	}
	if (values.account === 'work') env.CLAUDE_CONFIG_DIR = configDirectory;
	const helperTools = values.codex
		? ['mcp__codex__evidence', ...(delegating ? ['mcp__codex__implement'] : [])]
		: [];
	const tools = directExecution
		? 'Read,Glob,Grep,Edit,Write,Bash'
		: 'Read,Glob,Grep';
	const mcpConfig = values.codex
		? {
				mcpServers: {
					codex: {
						command: process.execPath,
						args: [
							join(import.meta.dir, 'codex-assistance.ts'),
							'--source',
							source,
							'--cwd',
							cwd,
							'--mode',
							values.mode,
							'--model',
							values['codex-model']!,
							'--max-calls',
							values['codex-max-calls'] ?? '4',
							'--timeout-ms',
							values['codex-timeout-ms'] ?? '300000',
							...skillWriteRoots.flatMap((root) => ['--write-root', root]),
						],
					},
				},
			}
		: undefined;
	const role = delegating
		? 'You own the bounded assignment, its reasoning, and the applied result in the assigned checkout. Read AGENTS.md and applicable skills. The coordinating Codex has handed you code-writing ownership of this checkout and pauses its own edits until you return. Preserve unrelated changes. Resolve implementation choices within accepted requirements; stop on missing product requirements that would change scope. Return changed paths, actual verification results and unresolved issues. The coordinating Codex owns continuity and focused acceptance, not a duplicate investigation or mandatory integration step.'
		: 'You own the requested read-only investigation, recommendation or text draft. Read source and check deciding evidence yourself. Return the finished answer, sources and unresolved uncertainty. The coordinating Codex owns execution and integration. If applying adversarial-review, perform the review yourself without commissioning another reviewer.';
	const execution = values.codex
		? `Use the assigned mcp__codex__evidence tool for bounded exploration that compresses into useful evidence.${delegating ? ' Use mcp__codex__implement for bounded edits and checks; the helper is the sole code writer in the assigned checkout. You own the implementation brief, inspect the resulting code and verification, and return focused corrections to that helper.' : ' You have no implementation capability. Return runtime check requests to the coordinator.'} Inspect deciding sources yourself. Do not forward the entire assignment unchanged. Helper limits apply per connection; report partial work if exhausted. Resume only a helper session returned by that same tool in this connection. Do not use the Codex plugin rescue workflow or launch other agents.`
		: delegating
			? 'Implement and run relevant checks within the brief. Do not launch child agents. Return blocked checks to the coordinator.'
			: 'Do not run commands, edit files or launch child agents. Return specific execution evidence requests to the coordinator.';
	const args = [
		'--print',
		'--output-format',
		'json',
		'--restricted',
		'--tools',
		tools,
		...(directExecution || values.codex
			? ['--allowedTools', [tools, ...helperTools].join(',')]
			: []),
		...(!values.codex
			? ['--disallowedTools', 'mcp__*']
			: ['--mcp-config', JSON.stringify(mcpConfig)]),
		'--strict-mcp-config',
		'--permission-mode',
		'dontAsk',
		'--settings',
		JSON.stringify(settings),
		'--model',
		model,
		'--effort',
		effort,
		'--append-system-prompt',
		`${role}\n${execution}\nDo not commit, push, publish, deploy, alter remotes or change access settings. Existing task authorization bounds every helper assignment.`,
		...(values.resume ? ['--resume', values.resume] : []),
	];
	if (values['dry-run']) {
		console.log(
			JSON.stringify(
				{
					cwd,
					args,
					account: values.account,
					configDirectory,
					expectedEmail,
					removedEnv,
				},
				null,
				2,
			),
		);
		return;
	}
	const status = spawnSync(
		'claude',
		[
			'--restricted',
			'--settings',
			JSON.stringify(settings),
			'auth',
			'status',
			'--json',
		],
		{ cwd, env, encoding: 'utf8', timeout: 30_000 },
	);
	if (status.error) throw status.error;
	if (status.status !== 0)
		throw new Error(
			`Account ${values.account} is not signed in. Use native Claude login for that profile.`,
		);
	const identity: unknown = JSON.parse(status.stdout);
	if (
		!identity ||
		typeof identity !== 'object' ||
		!('loggedIn' in identity) ||
		identity.loggedIn !== true ||
		!('authMethod' in identity) ||
		identity.authMethod !== 'claude.ai' ||
		!('apiProvider' in identity) ||
		identity.apiProvider !== 'firstParty' ||
		!('subscriptionType' in identity) ||
		typeof identity.subscriptionType !== 'string' ||
		!['pro', 'max', 'team', 'enterprise'].includes(identity.subscriptionType) ||
		!('email' in identity) ||
		typeof identity.email !== 'string' ||
		identity.email.toLowerCase() !== expectedEmail.toLowerCase() ||
		!('configDirectory' in identity) ||
		typeof identity.configDirectory !== 'string' ||
		resolve(identity.configDirectory) !== resolve(configDirectory)
	)
		throw new Error(
			`Account ${values.account} does not match the expected paid Claude subscription. No prompt was sent.`,
		);
	console.error(
		`Using Claude account ${values.account}: ${identity.email} (${identity.subscriptionType}).`,
	);
	// Stream native JSON and diagnostics without owning another session format.
	const child = Bun.spawn(['claude', ...args], {
		cwd,
		env,
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

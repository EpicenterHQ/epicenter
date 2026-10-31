/**
 * The command surface, through fresh CLI processes: the grammar, exit codes,
 * help, and the signed-out auth commands. `check` and `format`, which take a
 * contract, are in `contract-commands.test.ts`.
 *
 * They run `src/bin.ts` under Bun, or the compiled binary that
 * `EPICENTER_BIN` names, so the binary the desktop app ships passes the same
 * suite:
 *
 *   EPICENTER_BIN=apps/epicenter/src-tauri/binaries/epicenter-cli-<triple> bun test src/epicenter.test.ts
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary = process.env.EPICENTER_BIN;
const command = binary
	? [resolve(binary)]
	: [process.execPath, '--no-install', resolve(import.meta.dir, 'bin.ts')];
const temporaryFolders: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryFolders
			.splice(0)
			.map((folder) => rm(folder, { recursive: true, force: true })),
	);
});

async function setup() {
	const folder = await mkdtemp(join(tmpdir(), 'epicenter-cli-test-'));
	temporaryFolders.push(folder);
	function run(...args: string[]) {
		const result = Bun.spawnSync([...command, ...args], {
			cwd: folder,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		return {
			exitCode: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	}
	return { folder, run };
}

test('the CLI rejects missing or extra arguments', async () => {
	const { folder, run } = await setup();
	expect(run('check').exitCode).toBe(2);
	expect(run('check', 'contract.json', folder, 'extra').exitCode).toBe(2);
	expect(run('validate', folder).exitCode).toBe(2);
	expect(run('--help').stdout).toContain('epicenter check <contract> [<dir>]');
});

// ============================================================================
// The command surface (ADR-0558)
// ============================================================================

test('a command line the grammar refuses exits 2 and says why', async () => {
	const { folder, run } = await setup();
	expect(run('open', folder).stderr).toContain("Unknown command 'open'");
	expect(run('sync', folder, '--onto', 'x').stderr).toContain(
		'epicenter sync does not take --onto',
	);
	expect(run('sync', folder, '--interval').stderr).toContain(
		'--interval needs',
	);
	expect(run('auth').exitCode).toBe(2);
	expect(run('auth', 'approve', 'x').stderr).toContain(
		"Unknown command 'epicenter auth approve'",
	);
});

test('--help lists every command but send and install-command, and --json describes them', async () => {
	const { run } = await setup();
	const help = run('--help');
	expect(help.exitCode).toBe(0);
	for (const usage of [
		'epicenter sync [<dir>] [--watch]',
		'epicenter auth git-credential get | store | erase',
	])
		expect(help.stdout).toContain(usage);
	expect(help.stdout).not.toContain('epicenter send');
	expect(help.stdout).not.toContain('install-command');
	expect(help.stdout).not.toContain('--desktop');
	const described = JSON.parse(run('--help', '--json').stdout).commands;
	expect(described.map((c: { command: string }) => c.command)).toEqual([
		'folders pin',
		'folders unpin',
		'folders list',
		'folders remove-recent',
		'check',
		'format',
		'init',
		'sync',
		'status',
		'clone',
		'forget',
		'repos',
		'share',
		'unshare',
		'auth login',
		'auth logout',
		'auth status',
		'auth token',
		'auth git-credential',
		'auth key',
	]);
	expect(help.stdout).toContain('epicenter auth key set | remove | state <id>');
	expect(
		described.find((c: { command: string }) => c.command === 'sync').output,
	).toBe('ndjson');
	expect(run('auth', '--help').stdout).toContain('epicenter auth login');
	expect(run('check', '--help').stdout).toContain('compiler style');
	expect(JSON.parse(run('--version', '--json').stdout).version).toMatch(
		/^\d+\.\d+\.\d+/,
	);
});

// ============================================================================
// auth, signed out (the sign-ins themselves: auth.postgres.test.ts)
// ============================================================================

test('auth commands on a machine with no sign-in: status says so, and the rest refuse or stay silent', async () => {
	const { folder } = await setup();
	const run = (args: string[], stdin?: string) => {
		const result = Bun.spawnSync([...command, ...args], {
			cwd: folder,
			stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
			stdout: 'pipe',
			stderr: 'pipe',
			// Never the real keychain, machine state, or a real server.
			env: {
				...process.env,
				EPICENTER_TEST_SECRETS: '{}',
				EPICENTER_DATA_DIR: join(folder, '.data'),
				EPICENTER_API_URL: 'http://127.0.0.1:9',
			},
		});
		return {
			exitCode: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	};
	const status = run(['auth', 'status', '--json']);
	expect(status.exitCode).toBe(0);
	expect(JSON.parse(status.stdout)).toEqual({
		origin: 'http://127.0.0.1:9',
		grants: [
			{ grant: 'device', client: 'so.epicenter.cli', signedIn: false },
			{ grant: 'desktop', client: 'so.epicenter', signedIn: false },
		],
	});
	expect(run(['auth', 'status']).stdout).toContain(
		'This computer (epicenter auth login): signed out',
	);

	const token = run(['auth', 'token', '--json']);
	expect(token.exitCode).toBe(2);
	expect(JSON.parse(token.stdout).error).toContain('Run: epicenter auth login');
	const desktop = run(['auth', 'token', '--desktop']);
	expect(desktop.exitCode).toBe(2);
	expect(desktop.stderr).toContain("Sign in from Epicenter's Settings");
	expect(
		run(['auth', 'token', '--resource', 'https://example.com']).stderr,
	).toContain('is not a resource of this deployment');

	const logout = run(['auth', 'logout', '--json']);
	expect(logout.exitCode).toBe(0);
	expect(JSON.parse(logout.stdout)).toEqual({
		grant: 'device',
		signedOut: false,
		revoked: false,
	});

	// Git's protocol: another host gets no answer; this deployment's Git, when
	// signed out, an explanation on stderr; store and erase do nothing.
	const other = run(
		['auth', 'git-credential', 'get'],
		'protocol=https\nhost=github.com\n\n',
	);
	expect(other).toEqual({ exitCode: 0, stdout: '', stderr: '' });
	const ours = run(
		['auth', 'git-credential', 'get'],
		'protocol=http\nhost=127.0.0.1:9\npath=git/abc/notes.git\n\n',
	);
	expect(ours.stdout).toBe('');
	expect(ours.stderr).toContain('epicenter auth login');
	for (const action of ['store', 'erase'])
		expect(
			run(['auth', 'git-credential', action], 'protocol=http\n\n').exitCode,
		).toBe(0);
});

test('install-command refuses to link a CLI that runs from source', async () => {
	if (binary) return;
	const { run } = await setup();
	const result = run('install-command', '--json');
	expect(result.exitCode).toBe(2);
	expect(JSON.parse(result.stdout).error).toContain('runs from source');
});

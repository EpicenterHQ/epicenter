/**
 * The command surface, through fresh CLI processes: the grammar, exit codes,
 * help, and the signed-out auth commands. `check` and `format`, which take a
 * contract, are in `contract-commands.test.ts`.
 *
 * They run `src/bin.ts` under Bun, or the compiled binary that
 * `EPICENTER_BIN` names, so a compiled `epicenter` passes the same suite:
 *
 *   EPICENTER_BIN=<path to a compiled epicenter> bun test src/epicenter.test.ts
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
			env: { ...process.env, EPICENTER_STRICT_OUTPUT: '1' },
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
	expect(run('check', folder, 'extra').exitCode).toBe(2);
	expect(run('validate', folder).exitCode).toBe(2);
	expect(run('--help').stdout).toContain(
		'epicenter check [<dir>] [--contract <url or path>]',
	);
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
	expect(run('log', folder, '--limit').stderr).toContain('--limit needs');
	expect(run('auth').exitCode).toBe(2);
	expect(run('auth', 'approve', 'x').stderr).toContain(
		"Unknown command 'epicenter auth approve'",
	);
});

test('--help lists every command but the hidden ones, and --json describes them', async () => {
	const { run } = await setup();
	const help = run('--help');
	expect(help.exitCode).toBe(0);
	for (const usage of [
		'epicenter sync [<folder>] [--join <id>] [--create] [--push-deletions] [--restore-deletions] [--all]',
		'epicenter clone [<folder> [<name>]]',
		'epicenter share <folder> [<email>] [--role member|reader]',
		'epicenter restore <moment> [<dir>] [--path <path>]',
	])
		expect(help.stdout).toContain(usage);
	expect(help.stdout).not.toContain('--desktop');
	expect(run('sync', '--help').stdout).toContain('one\nrecord per folder');
	const described = JSON.parse(run('--help', '--json').stdout).commands;
	expect(described.map((c: { command: string }) => c.command)).toEqual([
		'check',
		'format',
		'status',
		'init',
		'sync',
		'clone',
		'log',
		'history',
		'show',
		'at',
		'mark',
		'diff',
		'restore',
		'export',
		'import',
		'share',
		'unshare',
		'accept',
		'attach',
		'detach',
		'mcp',
		'auth login',
		'auth logout',
		'auth status',
		'auth token',
	]);
	type Described = { command: string; ndjson?: true; input?: object };
	const find = (name: string) =>
		(described as Described[]).find(({ command }) => command === name);
	expect(find('auth login')?.ndjson).toBe(true);
	// An operation is described with the input schema its tool takes.
	expect(find('sync')?.input).toMatchObject({
		type: 'object',
		properties: { pushDeletions: { type: 'boolean' } },
	});
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
	const run = (args: string[]) => {
		const result = Bun.spawnSync([...command, ...args], {
			cwd: folder,
			stdin: 'ignore',
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
		client: 'so.epicenter.cli',
		signedIn: false,
	});
	expect(run(['auth', 'status']).stdout).toContain(
		'Signed out: run epicenter auth login',
	);

	const token = run(['auth', 'token', '--json']);
	expect(token.exitCode).toBe(2);
	expect(JSON.parse(token.stdout).error).toContain('Run: epicenter auth login');
	// The Epicenter app's sign-in is its own, not one the CLI selects.
	const desktop = run(['auth', 'token', '--desktop']);
	expect(desktop.exitCode).toBe(2);
	expect(desktop.stderr).toContain('does not take --desktop');
	expect(
		run(['auth', 'token', '--resource', 'https://example.com']).stderr,
	).toContain('is not a resource of this deployment');

	const logout = run(['auth', 'logout', '--json']);
	expect(logout.exitCode).toBe(0);
	expect(JSON.parse(logout.stdout)).toEqual({
		signedOut: false,
		revoked: false,
	});

	// A sync with no sign-in says how to sign in, and changes nothing.
	const synced = run(['sync', folder, '--json']);
	expect(synced.exitCode).toBe(2);
	expect(JSON.parse(synced.stdout).error).toContain('epicenter auth login');
});

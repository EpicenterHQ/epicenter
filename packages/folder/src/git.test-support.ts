/**
 * Run the system `git` in tests with no global or system config, a fixed
 * identity and no prompts, and make the scratch directories they run in.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_TERMINAL_PROMPT: '0',
	GIT_AUTHOR_NAME: 'Native',
	GIT_AUTHOR_EMAIL: 'native@example.test',
	GIT_COMMITTER_NAME: 'Native',
	GIT_COMMITTER_EMAIL: 'native@example.test',
};

export async function git(cwd: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(['git', ...args], {
		cwd,
		env: GIT_ENV,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(' ')}: ${stderr}`);
	return stdout.trim();
}

export async function scratch(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

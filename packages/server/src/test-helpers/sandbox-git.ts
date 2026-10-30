/**
 * The system `git` (and `git-lfs`) in a sandbox: `HOME`, `GIT_CONFIG_GLOBAL`
 * and `GIT_CEILING_DIRECTORIES` point into a temporary directory, so no
 * test reads or writes the person's own configuration, and no command walks
 * up into a repository that encloses the temporary directory.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type GitRun = { code: number; stdout: string; stderr: string };

export type GitSandbox = {
	root: string;
	env: Record<string, string>;
	/** Run `git` with `args` in `cwd`; `input` goes to stdin. */
	git(
		cwd: string,
		args: string[],
		input?: string | Uint8Array,
	): Promise<GitRun>;
	/** `git`, failing the test with its output when it exits non-zero. */
	ok(cwd: string, args: string[], input?: string | Uint8Array): Promise<string>;
	/** A new empty directory under the sandbox. */
	dir(name: string): Promise<string>;
	/** Write `files` (path to text or bytes) under `dir`. */
	write(dir: string, files: Record<string, string | Uint8Array>): Promise<void>;
};

export async function createGitSandbox(extraConfig = ''): Promise<GitSandbox> {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-git-sandbox-'));
	const home = join(root, 'home');
	await mkdir(home, { recursive: true });
	const config = join(home, 'gitconfig');
	await writeFile(
		config,
		`[user]\n\tname = Test\n\temail = test@example.test\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n[credential]\n\thelper =\n${extraConfig}`,
	);
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '/usr/bin:/bin',
		HOME: home,
		GIT_CONFIG_GLOBAL: config,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CEILING_DIRECTORIES: root,
		GIT_TERMINAL_PROMPT: '0',
		LC_ALL: 'C',
	};
	const git = async (
		cwd: string,
		args: string[],
		input?: string | Uint8Array,
	): Promise<GitRun> => {
		const child = Bun.spawn(['git', ...args], {
			cwd,
			env,
			stdin: input === undefined ? 'ignore' : new Blob([input as BlobPart]),
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { code, stdout, stderr };
	};
	let counter = 0;
	return {
		root,
		env,
		git,
		async ok(cwd, args, input) {
			const run = await git(cwd, args, input);
			if (run.code !== 0)
				throw new Error(
					`git ${args.join(' ')} exited ${run.code}:\n${run.stdout}${run.stderr}`,
				);
			return run.stdout;
		},
		async dir(name) {
			const path = join(root, `${name}-${++counter}`);
			await mkdir(path, { recursive: true });
			return path;
		},
		async write(dir, files) {
			for (const [path, content] of Object.entries(files)) {
				await mkdir(dirname(join(dir, path)), { recursive: true });
				await writeFile(join(dir, path), content);
			}
		},
	};
}

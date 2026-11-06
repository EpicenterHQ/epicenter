/**
 * The system `git`, which `epicenter export --git` and `import --git` drive
 * (ADR-0824, ADR-0826): the only place on a computer Epicenter runs Git,
 * and only to write or read a repository a person named, never a folder
 * Epicenter syncs.
 */

/** What one run of `git` answered. */
export type GitRun = { code: number; stdout: Uint8Array; stderr: string };

/**
 * Run `git` with `args` in `cwd`, writing `input` to its stdin when given,
 * in the person's environment (their credential helpers reach a remote)
 * with `env` laid over it, and no terminal prompt.
 */
export async function git(
	args: readonly string[],
	{
		cwd,
		input,
		env = {},
	}: {
		cwd?: string;
		input?: Uint8Array | ReadableStream<Uint8Array>;
		env?: Record<string, string>;
	} = {},
): Promise<GitRun> {
	const child = Bun.spawn(['git', ...args], {
		cwd,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
		stdin: input ?? 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).arrayBuffer(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout: new Uint8Array(stdout), stderr };
}

const decoder = new TextDecoder();

/** Run `git`, answering its stdout as text, or throwing with its stderr when it fails. */
export async function gitText(
	args: readonly string[],
	options: Parameters<typeof git>[1] = {},
): Promise<string> {
	const run = await git(args, options);
	if (run.code !== 0)
		throw new Error(
			`git ${args[0]} failed (${run.code}): ${run.stderr.trim() || decoder.decode(run.stdout).trim()}`,
		);
	return decoder.decode(run.stdout);
}

/** The text of a Git LFS pointer naming `oid` (a SHA-256) and `size`. */
export const lfsPointer = (oid: string, size: number) =>
	`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

const POINTER =
	/^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n$/;

/** The object a Git LFS pointer names, or null when `bytes` are no pointer. */
export function readLfsPointer(
	bytes: Uint8Array,
): { oid: string; size: number } | null {
	if (bytes.byteLength > 200) return null;
	const found = POINTER.exec(decoder.decode(bytes));
	return found === null
		? null
		: { oid: found[1] as string, size: Number(found[2]) };
}

/** Where Git LFS keeps `oid` below a repository's Git directory: `lfs/objects/<aa>/<bb>/<oid>`. */
export const lfsObjectPath = (gitDir: string, oid: string) =>
	`${gitDir}/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`;

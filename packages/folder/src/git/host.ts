/**
 * What history entering and leaving as Git needs of the computer it runs on
 * (ADR-0826): the system `git`, a scratch directory, a Git LFS object read
 * from a repository's store, and handing a repository over to Epicenter.
 * This is the only place a computer runs Git for Epicenter, and only to read
 * or write a repository a person named, never a folder Epicenter syncs.
 *
 * Bun provides one (`gitHost` in `@epicenter/folder/node`); the Epicenter
 * app's shell provides one through its own commands. The rest of this
 * module is plain text: LFS pointers, and paths joined either way a
 * computer separates them.
 */
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

/** What one run of `git` answered. */
export type GitRun = { code: number; stdout: Uint8Array; stderr: string };

/** A computer with Git, as an import reaches it. */
export type GitHost = {
	/**
	 * Run `git` with `args` in `cwd`, writing `input` to its stdin when
	 * given, in the person's environment (their credential helpers reach a
	 * remote) and with no terminal prompt.
	 */
	run(
		args: readonly string[],
		options?: { cwd?: string; input?: Uint8Array },
	): Promise<GitRun>;
	/** A new, empty directory to work in, and how to remove it with all it holds. */
	scratch(): Promise<{ path: string; remove(): Promise<void> }>;
	/**
	 * The bytes of the Git LFS object `oid` in the store below `dir` (a
	 * repository's Git directory, or a bare repository):
	 * `<dir>/lfs/objects/<aa>/<bb>/<oid>`; null when it is not there.
	 */
	lfsObject(dir: string, oid: string): Promise<Uint8Array | null>;
	/**
	 * Move the repository at `from` to `to`, refused when anything is at
	 * `to`, and leave a link at `from` that points to `target`.
	 */
	handOver(move: { from: string; to: string; target: string }): Promise<void>;
};

/** Why an import, an export, or an abandon stopped: its message says what to do. */
export const GitError = defineErrors({
	Failed: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
});
export type GitError = InferErrors<typeof GitError>;

const decoder = new TextDecoder();

/** Run `git` on `host`, answering its stdout as text, or throwing with its stderr when it fails. */
export async function gitText(
	host: Pick<GitHost, 'run'>,
	args: readonly string[],
	options: { cwd?: string; input?: Uint8Array } = {},
): Promise<string> {
	const run = await host.run(args, options);
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
	joinPath(gitDir, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);

/** The separator `path` uses: a backslash only for a Windows path that has no slash. */
const separatorOf = (path: string) =>
	path.includes('\\') && !path.includes('/') ? '\\' : '/';

/** `parts` joined below `base` with its separator. */
export function joinPath(base: string, ...parts: string[]): string {
	const separator = separatorOf(base);
	return [base.replace(/[\\/]+$/, ''), ...parts].join(separator);
}

/** The last segment of `path`. */
export const baseName = (path: string) =>
	path
		.replace(/[\\/]+$/, '')
		.split(/[\\/]/)
		.pop() ?? '';

/** `path` without its last segment. */
export function dirName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, '');
	const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
	return at <= 0 ? trimmed.slice(0, at + 1) || '.' : trimmed.slice(0, at);
}

/** Whether `path` is `parent` or below it. */
export function isWithin(path: string, parent: string): boolean {
	const trim = (value: string) => value.replace(/[\\/]+$/, '');
	const at = trim(path);
	const above = trim(parent);
	if (above === '') return false;
	return (
		at === above || at.startsWith(`${above}/`) || at.startsWith(`${above}\\`)
	);
}

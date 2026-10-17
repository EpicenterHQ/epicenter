/**
 * Which captured files are history source.
 *
 * Status, commits, and incoming fast-forwards share one rule: a path the
 * folder definition's `local` patterns match is never source, tracked or
 * not, whatever `.gitignore` says; otherwise a file tracked in the committed
 * tree stays source, and an untracked file is source unless `.gitignore`
 * excludes it. So a commit leaves a local file out, and one committed before
 * is untracked by the next commit while its bytes stay on disk. Private Git state and operating-system
 * scratch files are excluded earlier by `isPortablePath`. The browser evaluates
 * `.gitignore` files from the captured bytes; the native backend asks
 * `git check-ignore`, which also
 * honors `.git/info/exclude` and the user's excludes file.
 */
import ignore, { type Ignore } from 'ignore';

const decoder = new TextDecoder();

/**
 * Git-style ignore evaluation over captured `.gitignore` files. Deeper files
 * override shallower ones, a later rule overrides an earlier one, and nothing
 * below an ignored directory can be re-included.
 */
export function gitignoreMatcher(
	files: ReadonlyMap<string, Uint8Array>,
): (path: string) => boolean {
	const rules = new Map<string, Ignore>();
	for (const [path, bytes] of files) {
		if (path !== '.gitignore' && !path.endsWith('/.gitignore')) continue;
		const directory = path.slice(0, -'.gitignore'.length);
		rules.set(directory, ignore().add(decoder.decode(bytes)));
	}
	if (rules.size === 0) return () => false;
	return (path) => {
		const parts = path.split('/');
		const active: { prefix: string; matcher: Ignore }[] = [];
		for (let index = 0; index < parts.length; index++) {
			const prefix = index === 0 ? '' : `${parts.slice(0, index).join('/')}/`;
			const matcher = rules.get(prefix);
			if (matcher !== undefined) active.push({ prefix, matcher });
			const isDirectory = index < parts.length - 1;
			const current =
				parts.slice(0, index + 1).join('/') + (isDirectory ? '/' : '');
			let excluded = false;
			for (const rule of active) {
				const result = rule.matcher.test(current.slice(rule.prefix.length));
				if (result.ignored) excluded = true;
				else if (result.unignored) excluded = false;
			}
			if (excluded) return true;
		}
		return false;
	};
}

/**
 * Whether a folder definition's `local` patterns match `path`, or a directory
 * above it. The patterns are read as one root `.gitignore` would read them,
 * except that nothing re-includes a match: they hold whatever the folder's
 * own `.gitignore` files say.
 */
export function localMatcher(
	patterns: readonly string[] | undefined,
): (path: string) => boolean {
	if (patterns === undefined || patterns.length === 0) return () => false;
	const matcher = ignore().add([...patterns]);
	return (path) => {
		const parts = path.split('/');
		for (let index = 0; index < parts.length; index++) {
			const isDirectory = index < parts.length - 1;
			const current =
				parts.slice(0, index + 1).join('/') + (isDirectory ? '/' : '');
			if (matcher.ignores(current)) return true;
		}
		return false;
	};
}

/**
 * Keep tracked files and untracked files that are not ignored, never a file
 * `isLocal` matches. `isAppLocal`, the `local` patterns of an app that reads
 * a folder it is not the owner of, leaves out only untracked files: what the
 * app keeps on this machine never enters that folder's history, and what the
 * folder already tracks stays tracked, since its own declaration says so.
 */
export async function sourceFiles(
	current: ReadonlyMap<string, Uint8Array>,
	tracked: ReadonlyMap<string, unknown>,
	ignoredPaths: (
		candidates: readonly string[],
		current: ReadonlyMap<string, Uint8Array>,
	) => Promise<ReadonlySet<string>>,
	isLocal: (path: string) => boolean = () => false,
	isAppLocal: (path: string) => boolean = () => false,
): Promise<Map<string, Uint8Array>> {
	const candidates = [...current.keys()].filter(
		(path) => !tracked.has(path) && !isLocal(path) && !isAppLocal(path),
	);
	const ignored =
		candidates.length === 0
			? new Set<string>()
			: await ignoredPaths(candidates, current);
	const source = new Map<string, Uint8Array>();
	for (const [path, bytes] of current)
		if (
			!ignored.has(path) &&
			!isLocal(path) &&
			(tracked.has(path) || !isAppLocal(path))
		)
			source.set(path, bytes);
	return source;
}

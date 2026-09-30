/**
 * Which captured files are history source.
 *
 * Status, automatic commits, and incoming fast-forwards share one rule: a file
 * tracked in the committed tree stays source; an untracked file is source
 * unless `.gitignore` excludes it. Private Git state, operating-system scratch
 * files, and the root generated `index.sqlite3` are excluded earlier by
 * `isPortablePath`. The browser evaluates `.gitignore` files from the
 * captured bytes; the native backend asks `git check-ignore`, which also
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

/** Keep tracked files and untracked files that are not ignored. */
export async function sourceFiles(
	current: ReadonlyMap<string, Uint8Array>,
	tracked: ReadonlyMap<string, unknown>,
	ignoredPaths: (
		candidates: readonly string[],
		current: ReadonlyMap<string, Uint8Array>,
	) => Promise<ReadonlySet<string>>,
): Promise<Map<string, Uint8Array>> {
	const candidates = [...current.keys()].filter((path) => !tracked.has(path));
	const ignored =
		candidates.length === 0
			? new Set<string>()
			: await ignoredPaths(candidates, current);
	const source = new Map<string, Uint8Array>();
	for (const [path, bytes] of current)
		if (!ignored.has(path)) source.set(path, bytes);
	return source;
}

/**
 * Which files are history source: the one rule every host shares (ADR-0592).
 *
 * A file tracked in the committed tree stays source, whatever `.gitignore`
 * says, as in Git; untracking one is an explicit act, and history keeps
 * what it held. Any other file is source unless `.gitignore` excludes it,
 * and an excluded one is never read, save an ignored `.gitattributes` the
 * native checkpoint checks for a filter (`native-checkpoint.ts`), since one
 * changes what a commit holds. Nothing else decides what stays on one
 * machine: no definition, no app. Private Git state and operating-system
 * scratch files are excluded earlier by `isPortablePath`.
 *
 * Every host decides from the same bytes: the `.gitignore` files a capture
 * read, evaluated here. No host asks `git check-ignore`, which rereads the
 * live rule files after the capture took its copy, so a rule edited between
 * the two would choose a source the committed `.gitignore` does not. Nor does
 * any host honor `.git/info/exclude` or `core.excludesFile`: each is a
 * per-device policy a browser cannot see and a clone does not carry, and
 * ADR-0592 makes the folder's `.gitignore` the one rule.
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
		if (!isGitignorePath(path)) continue;
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
 * The bytes of every `.gitignore` among `paths` that is a rule: read from
 * the root down, so a file `tracked` lacks under a directory a shallower
 * rule excludes is passed over, as Git never reads one there. A rule file
 * a pattern names itself, such as a line ignoring every `.gitignore`, still
 * applies; whether it is source is the caller's question. A tracked rule
 * file is a rule, and read, wherever it is. Rule files at one depth sit in
 * different directories, so only shallower ones decide them. `read` returns
 * the bytes of the paths it is given, leaving out one removed meanwhile.
 */
export async function readRules(
	paths: readonly string[],
	tracked: { has(path: string): boolean },
	read: (paths: readonly string[]) => Promise<Map<string, Uint8Array>>,
): Promise<Map<string, Uint8Array>> {
	const depth = (path: string) => path.split('/').length;
	const byDepth = new Map<number, string[]>();
	for (const path of paths.filter(isGitignorePath))
		byDepth.set(depth(path), [...(byDepth.get(depth(path)) ?? []), path]);
	const rules = new Map<string, Uint8Array>();
	for (const level of [...byDepth.keys()].sort((a, b) => a - b)) {
		const ignored = gitignoreMatcher(rules);
		const directoryOf = (path: string) =>
			path.slice(0, path.lastIndexOf('/') + 1);
		const candidates = byDepth
			.get(level)!
			.filter(
				(path) =>
					tracked.has(path) ||
					!path.includes('/') ||
					!ignored(directoryOf(path)),
			);
		for (const [path, bytes] of await read(candidates)) rules.set(path, bytes);
	}
	return rules;
}

/** Whether `path` is a `.gitignore` file, whose rules decide what is source. */
export function isGitignorePath(path: string): boolean {
	return path === '.gitignore' || path.endsWith('/.gitignore');
}

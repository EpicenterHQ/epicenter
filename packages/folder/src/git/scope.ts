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
 * scratch files are excluded earlier by `isPortablePath`. The browser
 * evaluates `.gitignore` files from their bytes; the native backend asks
 * `git check-ignore`, which also honors `.git/info/exclude` and the user's
 * excludes file.
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
		if (!isGitignore(path)) continue;
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

/** Whether `path` is a `.gitignore` file, whose rules decide what is source. */
export function isGitignore(path: string): boolean {
	return path === '.gitignore' || path.endsWith('/.gitignore');
}

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

/** Prepare one review for either pasted lines or a built-in starter list. */
export function reviewImport(raw: string, saved: ReadonlySet<string>) {
	const seen = new Set<string>();
	const eligible: string[] = [];
	let repeated = 0;
	let alreadySaved = 0;
	for (const line of raw.split('\n')) {
		const text = line.trim();
		if (!text) continue;
		if (seen.has(text)) {
			repeated++;
			continue;
		}
		seen.add(text);
		if (saved.has(text)) {
			alreadySaved++;
			continue;
		}
		eligible.push(text);
	}
	return { eligible, repeated, alreadySaved };
}

/** Original, small starter list curated for the Vocab app. */
export const STARTER_LIST = [
	'by and large',
	'cut to the chase',
	'in hindsight',
	'on the fence',
	'subtle',
	'lucid',
	'nuance',
	'resilient',
	'ambiguous',
	'candid',
].join('\n');

/**
 * What the UI does with a word's text: the file it names, search that ignores
 * case, accents, and spaces, the language to tag a word with so the browser
 * picks the right CJK glyphs, and short times until a review.
 */

/** The file of `word`, as a page's URL names it: `words/你好.md`. */
export const pathOf = (word: string) => `words/${word}.md`;

/** The word the file at `path` is named by: `你好` for `words/你好.md`. */
export const wordOf = (path: string) => path.replace(/^words\//, '').replace(/\.md$/, '');

/** Text as search compares it: lowercase, no accents or tone marks, numbers, or spaces, so `nihao` finds `nǐ hǎo`. */
export function searchable(text: string): string {
	return text
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[\s\d'’-]/g, '');
}

/** Whether a word's text, reading, or meaning holds `query`, ignoring case, accents, and spaces. */
export function matches(
	word: { path: string; reading?: string; meaning?: string },
	query: string,
): boolean {
	const wanted = searchable(query);
	if (wanted === '') return true;
	return [wordOf(word.path), word.reading ?? '', word.meaning ?? ''].some((text) =>
		searchable(text).includes(wanted),
	);
}

/** The language a word's script implies, for `lang`: Chinese, Japanese, or Korean; `undefined` for any other. */
export function langOf(text: string): string | undefined {
	if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja';
	if (/\p{Script=Hangul}/u.test(text)) return 'ko';
	if (/\p{Script=Han}/u.test(text)) return 'zh';
	return undefined;
}

/** How long from `now` until `at`, short: `10 min`, `3 h`, `6 d`, `2 mo`, `1 y`; `now` once it has passed. */
export function untilLabel(at: string, now: Date): string {
	const minutes = Math.round((Date.parse(at) - now.getTime()) / 60_000);
	if (minutes <= 0) return 'now';
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h`;
	const days = Math.round(hours / 24);
	if (days < 31) return `${days} d`;
	if (days < 365) return `${Math.round(days / 30)} mo`;
	return `${Math.round(days / 365)} y`;
}

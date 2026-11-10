/**
 * What the view does with a word's text: tone marks for pinyin typed with
 * numbers, search that ignores tones, the language to tag a word with so the
 * browser picks the right CJK glyphs, and short times until a review.
 */

const MARKS: Record<string, string> = {
	a: 'āáǎà',
	e: 'ēéěè',
	i: 'īíǐì',
	o: 'ōóǒò',
	u: 'ūúǔù',
	ü: 'ǖǘǚǜ',
};

/** The index of the vowel that takes a syllable's tone mark: a or e, else the o of ou, else the last vowel. */
function markedVowel(syllable: string): number {
	const lower = syllable.toLowerCase();
	const ae = lower.search(/[ae]/);
	if (ae >= 0) return ae;
	const ou = lower.indexOf('ou');
	if (ou >= 0) return ou;
	return Math.max(...[...'iouü'].map((vowel) => lower.lastIndexOf(vowel)));
}

/**
 * Pinyin typed with tone numbers, with tone marks: `ni3 hao3` is `nǐ hǎo`,
 * `nv3` and `nu:3` are `nǚ`, and a 5 or 0 (the neutral tone) is dropped.
 * Text without tone numbers comes back unchanged.
 */
export function markTones(text: string): string {
	return text.replace(/([a-zü:]+)([0-5])/gi, (whole, letters: string, tone: string) => {
		const syllable = letters.replace(/u:|v/g, 'ü').replace(/U:|V/g, 'Ü');
		if (!/[aeiouü]/i.test(syllable)) return whole;
		if (tone === '5' || tone === '0') return syllable;
		const at = markedVowel(syllable);
		const vowel = syllable[at] ?? '';
		const marked = MARKS[vowel.toLowerCase()]?.[Number(tone) - 1] ?? vowel;
		const cased = vowel === vowel.toLowerCase() ? marked : marked.toUpperCase();
		return syllable.slice(0, at) + cased + syllable.slice(at + 1);
	});
}

/** Text as search compares it: lowercase, no tone marks, numbers, or spaces, so `nihao` finds `nǐ hǎo`. */
export function searchable(text: string): string {
	return text
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[\s\d'’-]/g, '');
}

/** Whether a word's text, reading, or meaning holds `query`, ignoring case, tones, and spaces. */
export function matches(
	word: { word: string; reading?: string; meaning?: string },
	query: string,
): boolean {
	const wanted = searchable(query);
	if (wanted === '') return true;
	return [word.word, word.reading ?? '', word.meaning ?? ''].some((text) =>
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

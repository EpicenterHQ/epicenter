/**
 * Entry candidates: propose savable spans from one settled assistant message.
 *
 * Ask the model to extract notable English spans from a settled answer, so the
 * learner can save phrases without selecting each one in the rendered text.
 *
 * Nothing here is persisted. The model's output is transient: it becomes a list
 * of candidate strings the user chooses from, and only the chosen `text` flows
 * through the one entry writer (`entriesState.save`). No gloss, no meaning, no
 * provenance, no language, and no candidate metadata is ever stored (ADR-0102).
 *
 * Vocab teaches English, so a candidate must be an English expression from the
 * passage rather than explanatory glue or a translated equivalent.
 */

/**
 * Fixed instruction for a completion that reads the passage as its user turn.
 *
 * It asks for spans only, no glosses, because the meaning lives in the chat the
 * span came from, never in a stored definition (ADR-0102). The parser
 * ({@link parseEntryCandidates}) recovers spans even when the model disobeys and
 * adds numbering or a gloss anyway, so this stays a request, not a contract.
 */
export const ENTRY_CANDIDATE_PROMPT = [
	'You extract English vocabulary spans a learner might want to save from a passage they just read.',
	'A span is a verbatim stretch worth learning on its own: a single word, a phrase, or an idiom.',
	'',
	'Rules:',
	'- Output one span per line, copied verbatim from the passage.',
	'- Extract only English words, phrases, or idioms from the passage.',
	'- Do not number the lines, do not add bullets, and do not wrap spans in quotes.',
	'- Do not add a meaning, translation, or reading. Output the spans and nothing else.',
	'- Skip trivial filler and anything not worth saving as its own entry.',
].join('\n');

/**
 * Turn one entry-candidate response into clean strings.
 *
 * The model is asked for a bare list, but this stays robust to the common ways
 * it strays: numbering (`1.`, `2)`), bullets (`-`, `*`, `•`), a header line
 * (`Vocabulary:`), a gloss it appended anyway (`lucid - clear`),
 * markdown wrapping (`**span**`, `` `span` ``), and code fences. Each line is
 * cleaned to the span alone; blanks and header lines drop out; duplicates
 * collapse to the first occurrence with order preserved.
 *
 * It never invents or translates: a line that is already a clean span passes
 * through verbatim (inner spacing intact), so a legitimate multi-word phrase is
 * not mistaken for a gloss. The human is the final filter; this only removes
 * formatting the model wrapped around the spans.
 */
export function parseEntryCandidates(raw: string): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const line of raw.split('\n')) {
		const span = cleanLine(line);
		if (!span || seen.has(span)) continue;
		seen.add(span);
		candidates.push(span);
	}
	return candidates;
}

/**
 * Reduce one raw line to the span it carries, or `''` to drop it. Order is
 * load-bearing: strip a leading list marker first, drop a trailing-colon header
 * before anything else can rescue it, then split off an appended gloss, then
 * peel markdown/quote wrapping from the edges.
 */
function cleanLine(line: string): string {
	let span = line.trim();
	if (!span) return '';
	// Leading list marker the model added despite the instruction: "- ", "* ",
	// "• ", "1. ", "2) ". Requires trailing space so a hyphenated word is safe.
	span = span.replace(/^(?:[-*•–]|\d+[.)])\s+/, '');
	// A header like "Vocabulary:" is not an entry; a real span never ends in a colon.
	if (/[:]\s*$/.test(span)) return '';
	// The model glossed anyway: keep the part before a spaced dash or colon.
	// Spaced separators preserve a hyphenated expression such as "state-of-the-art".
	span = span.split(/\s[-–—]\s|:\s/)[0] ?? '';
	// Peel markdown emphasis, backticks, and quotes the model wrapped around it.
	span = span.replace(/^[\s"'`*_]+|[\s"'`*_]+$/g, '');
	return span.trim();
}

/**
 * Conflict blocks: the one grammar Epicenter writes and reads, so a block
 * a merge wrote is exactly a block an editor shows and a lint counts.
 *
 * ```
 * <<<<<<< current alice/laptop 2026-10-28T14:02:11Z 3f2a1c9
 * the current side's lines
 * ||||||| base 9b8e7d6
 * the base's lines
 * =======
 * the incoming side's lines
 * >>>>>>> incoming bob/phone 2026-10-28T14:02:12Z 1a2b3c4
 * ```
 *
 * Each label names its side, who wrote it, when, and the version (a short
 * Git blob id) of the whole note that side had; the base names its version.
 * A section line that would read as a delimiter, or as an escaped one, is
 * written with one more leading backslash and read back with one fewer, so
 * a note's own text can never open, split or close a block. Only a block
 * whose delimiters come in order, each labelled, with no block inside it,
 * is a conflict; anything else is text (`lint` warns about it).
 */
import { gitBlobHash } from './hash.js';

/** Who wrote a side and when: a label's author and time. */
export type Party = { author: string; time: string };
/** A side's label: its party and the version of the note it had. */
export type Side = Party & { version: string };
export type Labels = { current: Side; incoming: Side; base?: { version: string } };

/** The short version label for a note's text: its Git blob id's first 7 digits, `-` for no note. */
export const versionOf = (text: string | null) => (text === null ? '-' : gitBlobHash(text).slice(0, 7));

const OPEN = '<<<<<<< ';
const BASE = '||||||| base';
const SPLIT = '=======';
const CLOSE = '>>>>>>> ';

const isDelimiter = (line: string) =>
	line.startsWith(OPEN) || line.startsWith('|||||||') || line.startsWith(SPLIT) || line.startsWith(CLOSE.trimEnd());

/** A content line that would read as a delimiter (or as an escaped one) gets one more backslash. */
const escapeLine = (line: string) => (isDelimiter(line.replace(/^\\+/, '')) ? `\\${line}` : line);
const unescapeLine = (line: string) => (/^\\+/.test(line) && isDelimiter(line.replace(/^\\+/, '')) ? line.slice(1) : line);
export const escapeLines = (text: string) => text.split('\n').map(escapeLine).join('\n');

/** A label field holds no whitespace, so a label splits back into its fields. */
const field = (value: string) => value.replace(/\s+/g, '_') || '-';
const label = (side: 'current' | 'incoming', { author, time, version }: Side) => `${side} ${field(author)} ${field(time)} ${field(version)}`;

/** One block: each section's lines escaped, each delimiter labelled. */
export function block({ current, base = '', incoming }: { current: string; base?: string; incoming: string }, labels: Labels) {
	const section = (text: string) => (text === '' ? '' : `${escapeLines(text.endsWith('\n') ? text.slice(0, -1) : text)}\n`);
	const baseLine = labels.base === undefined ? BASE : `${BASE} ${field(labels.base.version)}`;
	return `${OPEN}${label('current', labels.current)}\n${section(current)}${baseLine}\n${section(base)}${SPLIT}\n${section(incoming)}${CLOSE}${label('incoming', labels.incoming)}\n`;
}

/** A block as found: where it is, its sections unescaped, and its labels. */
export type Conflict = {
	/** The line its opening delimiter is on, from 1. */
	line: number;
	/** Offsets of the block in the text: from its opening delimiter to past its closing line. */
	from: number;
	to: number;
	raw: string;
	current: string;
	base: string;
	incoming: string;
	/** The label texts after each delimiter. */
	labels: { current: string; base: string; incoming: string };
	/** The labels read as sides, when they have the fields Epicenter writes. */
	sides: { current: Side | null; incoming: Side | null };
};

const sideOf = (text: string, side: 'current' | 'incoming'): Side | null => {
	const [name, author, time, version, ...rest] = text.split(' ');
	if (name !== side || author === undefined || time === undefined || version === undefined || rest.length > 0) return null;
	return { author, time, version };
};

/** The well-formed conflict blocks in a text, in order. */
export function findConflicts(text: string): Conflict[] {
	const lines = text.split('\n');
	const starts: number[] = [];
	for (let i = 0, at = 0; i < lines.length; i++) {
		starts.push(at);
		at += (lines[i] ?? '').length + 1;
	}
	const found: Conflict[] = [];
	for (let i = 0; i < lines.length; i++) {
		const open = lines[i] ?? '';
		if (!open.startsWith(OPEN) || open.length <= OPEN.length) continue;
		let base = -1;
		let split = -1;
		let close = -1;
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j] ?? '';
			if (line.startsWith(OPEN)) break;
			if (base < 0 && (line === BASE || line.startsWith(`${BASE} `))) base = j;
			else if (base >= 0 && split < 0 && line === SPLIT) split = j;
			else if (split >= 0 && line.startsWith(CLOSE) && line.length > CLOSE.length) {
				close = j;
				break;
			}
		}
		if (close < 0) continue;
		const section = (from: number, to: number) =>
			lines
				.slice(from, to)
				.map((line) => `${unescapeLine(line)}\n`)
				.join('');
		const from = starts[i] ?? 0;
		const to = Math.min(text.length, (starts[close] ?? 0) + (lines[close] ?? '').length + 1);
		const labels = {
			current: open.slice(OPEN.length),
			base: (lines[base] ?? '').slice(BASE.length + 1),
			incoming: (lines[close] ?? '').slice(CLOSE.length),
		};
		found.push({
			line: i + 1,
			from,
			to,
			raw: text.slice(from, to),
			current: section(i + 1, base),
			base: section(base + 1, split),
			incoming: section(split + 1, close),
			labels,
			sides: { current: sideOf(labels.current, 'current'), incoming: sideOf(labels.incoming, 'incoming') },
		});
		i = close;
	}
	return found;
}

/** A block with its labels removed, so two blocks with the same sections compare equal whoever wrote them. */
const unlabelled = (text: string) => text.replace(/^(<<<<<<<|>>>>>>>) .*$/gm, '$1').replace(/^\|\|\|\|\|\|\| base .*$/gm, BASE);

/** `text` with `added` (one block) after it, unless a block with the same sections, whoever's labels, is already there. */
export function withBlock(text: string, added: string) {
	if (unlabelled(text).includes(unlabelled(added))) return text;
	return `${text === '' || text.endsWith('\n') ? text : `${text}\n`}${added}`;
}

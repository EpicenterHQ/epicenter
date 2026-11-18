/**
 * The files of a Whispering folder of `count` recordings, for the re-read
 * timing (`README.md`): each recording's note at `recordings/<id>.md`
 * beside an empty `recordings/<id>.webm`, and about one transcript each at
 * `transcriptions/<id>.md`. Notes are written by the app's own `newNote`,
 * so they read as the app's notes do. A seeded random makes the same files
 * every time, on disk (`fixture.ts`) and in a browser's OPFS (`opfs.ts`).
 *
 * - Recordings: a third untitled, a fifth with a few lines of notes, each
 *   with a duration.
 * - Transcripts: 10% of recordings have none and 10% have two, so there are
 *   about as many transcripts as recordings. A body is 0.5 to 6 KB of text
 *   (about 3.2 KB on average, a few minutes of speech).
 */
import { fieldNamesOf, NOTES } from '../../src/lib/format/layout.js';
import { newNote } from '../../src/lib/format/note.js';

/** mulberry32: a small seeded random in [0, 1). */
function seeded(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function* fixtureFiles(
	count: number,
): Generator<readonly [path: string, text: string]> {
	const random = seeded(count);
	const between = (low: number, high: number) =>
		Math.floor(low + random() * (high - low));
	const pick = <T>(items: readonly T[]) => items[between(0, items.length)] as T;

	const WORDS =
		'the a and to of I you it that is was we so like just know think going really this yeah okay about what have but for not do on with be right then they there um uh meeting project idea need should could would maybe actually call email tomorrow today week next plan write build ship review test design notes remember people time work thing things kind sort pretty good great sure because when where how why also still back more some any every one two three'.split(
			' ',
		);

	/** About `bytes` of speech-like text, a sentence per line as a transcript often is. */
	function speech(bytes: number) {
		const lines: string[] = [];
		let size = 0;
		while (size < bytes) {
			const words = Array.from({ length: between(6, 24) }, () => pick(WORDS));
			const first = words[0] as string;
			words[0] = first[0]?.toUpperCase() + first.slice(1);
			const line = `${words.join(' ')}.`;
			lines.push(line);
			size += line.length + 1;
		}
		return `${lines.join('\n')}\n`;
	}

	/** A `timeId` for `at` with a seeded suffix, so the folder is the same each run. */
	function idAt(at: Date) {
		const stamp = at
			.toISOString()
			.replace(/\.(\d{3})Z$/, '-$1Z')
			.replaceAll(':', '-');
		const suffix = Array.from({ length: 8 }, () =>
			pick([...'0123456789abcdefghijklmnopqrstuvwxyz']),
		).join('');
		return `${stamp}-${suffix}`;
	}

	const recordingOrder = fieldNamesOf(NOTES.recordings.fields);
	const transcriptOrder = fieldNamesOf(NOTES.transcriptions.fields);

	// About a recording every 90 minutes, ending now-ish.
	let at = Date.UTC(2026, 10, 18) - count * 90 * 60_000;
	for (let index = 0; index < count; index++) {
		at += between(5, 175) * 60_000 + between(0, 60_000);
		const recordedAt = new Date(at);
		const id = idAt(recordedAt);
		const durationMs = between(3_000, 600_000);
		const title =
			random() < 0.33
				? ''
				: Array.from({ length: between(2, 7) }, () => pick(WORDS)).join(' ');
		const notes = random() < 0.2 ? speech(between(100, 500)) : '';
		yield [
			`recordings/${id}.md`,
			newNote(
				{ title, recordedAt: recordedAt.toISOString(), durationMs },
				notes,
				recordingOrder,
			),
		];
		yield [`recordings/${id}.webm`, ''];
		const roll = random();
		const runs = roll < 0.1 ? 0 : roll < 0.9 ? 1 : 2;
		for (let run = 0; run < runs; run++) {
			const createdAt = new Date(at + durationMs + 2_000 + run * 3_600_000);
			yield [
				`transcriptions/${idAt(createdAt)}.md`,
				newNote(
					{
						recordingId: id,
						createdAt: createdAt.toISOString(),
						model: pick(['whisper-large-v3-turbo', 'gpt-4o-transcribe']),
						endpoint: pick([
							'groq',
							'openai',
							'https://api.groq.com/openai/v1',
						]),
					},
					speech(between(500, 6_000)),
					transcriptOrder,
				),
			];
		}
	}
}

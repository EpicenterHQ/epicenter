import {
	defineAction,
	defineApp,
	defineCollection,
	field,
	localTime,
} from '@epicenter/app';

const words = defineCollection({
	path: 'words/{word}.md',
	description: 'word I am learning',
	fields: {
		meaning: field.text({
			optional: true,
			description: 'What the word means: a translation or a short definition',
		}),
		reading: field.text({
			optional: true,
			description: 'How it is read or pronounced, such as pinyin, kana, or IPA',
		}),
		stage: field.select(['new', 'recognized', 'understood', 'usable'], {
			optional: true,
			description: 'How well I say I know it; only I set it',
		}),
		createdAt: field.datetime({
			readOnly: true,
			description: 'When it was added, RFC 3339 with an offset',
		}),
		due: field.datetime({
			optional: true,
			readOnly: true,
			description:
				'When it is next due for review; a word without one is new and due now',
		}),
		interval: field.number({
			optional: true,
			readOnly: true,
			min: 0,
			description: 'Days between the last review and the next (SM-2)',
		}),
		ease: field.number({
			optional: true,
			readOnly: true,
			min: 1.3,
			description:
				'How fast the interval grows after a good review (SM-2), 2.5 to start',
		}),
		reps: field.integer({
			optional: true,
			readOnly: true,
			min: 0,
			description:
				'Reviews in a row remembered since it was new or last forgotten',
		}),
	},
});

/** A row of `list`: a word's path and fields. */
export type WordRow = Awaited<ReturnType<typeof words.list>>[number];

/** A word as `get` reads it: its fields and its body, which holds examples and notes. */
export type Word = NonNullable<Awaited<ReturnType<typeof words.get>>>;

/** The four answers to "did I remember it?", as Anki names them. */
export const GRADES = ['again', 'hard', 'good', 'easy'] as const;
export type Grade = (typeof GRADES)[number];

/** What a review leaves in the word's scheduling fields. */
export type Schedule = {
	due: string;
	interval: number;
	ease: number;
	reps: number;
};

/** A word due now, with when each grade would make it due next. */
export type DueWord = Word & { next: Record<Grade, string> };

const START_EASE = 2.5;
const MIN_EASE = 1.3;
/** A forgotten word comes back in the same sitting. */
const AGAIN_MINUTES = 10;
/** A day of reviews starts at 4am local time, as Anki's does, so a review after midnight counts toward the night before. */
const DAY_STARTS_AT = 4;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * SM-2 with Anki's four grades. A remembered word's interval goes 1 day, 6
 * days, then grows by its ease; `hard` lowers the ease and grows the interval
 * by 1.2, `easy` raises it and grows the interval a third more than `good`,
 * and `again` starts it over, due in ten minutes. An interval of days is due
 * when that day of reviews starts, 4am local time, so a word reviewed in the
 * evening is due the next morning rather than the next evening.
 */
export function schedule(
	word: Pick<Word, 'interval' | 'ease' | 'reps'>,
	grade: Grade,
	now: Date,
): Schedule {
	const ease = word.ease ?? START_EASE;
	const reps = word.reps ?? 0;
	const interval = word.interval ?? 0;
	if (grade === 'again')
		return {
			due: new Date(now.getTime() + AGAIN_MINUTES * 60_000).toISOString(),
			interval: 0,
			ease: round2(Math.max(MIN_EASE, ease - 0.2)),
			reps: 0,
		};
	const good =
		reps === 0
			? 1
			: reps === 1
				? 6
				: Math.max(interval + 1, Math.round(interval * ease));
	const days = {
		hard: reps === 0 ? 1 : Math.max(interval + 1, Math.round(interval * 1.2)),
		good,
		easy: reps === 0 ? 4 : Math.max(good + 1, Math.round(good * 1.3)),
	}[grade];
	const change = { hard: -0.15, good: 0, easy: 0.15 }[grade];
	const due = new Date(now.getTime() - DAY_STARTS_AT * 3_600_000);
	due.setHours(DAY_STARTS_AT, 0, 0, 0);
	due.setDate(due.getDate() + days);
	return {
		due: due.toISOString(),
		interval: days,
		ease: round2(Math.max(MIN_EASE, ease + change)),
		reps: reps + 1,
	};
}

/**
 * Whether `word` is due at `now`: it has never been reviewed, or its time has
 * come. A `due` written by hand that is not a date and time reads as absent,
 * so that word is due now rather than never.
 */
export function isDue(word: Pick<Word, 'due'>, now: Date): boolean {
	return word.due === undefined || Date.parse(word.due) <= now.getTime();
}

/** The moment `at` names, or +Infinity when there is none, so those sort last. */
function instant(at: string | undefined): number {
	const parsed = at === undefined ? Number.NaN : Date.parse(at);
	return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/** When each grade would make `word` due next, reviewed at `now`. */
function nextFor(word: Pick<Word, 'interval' | 'ease' | 'reps'>, now: Date) {
	return Object.fromEntries(
		GRADES.map((grade) => [grade, schedule(word, grade, now).due]),
	) as Record<Grade, string>;
}

/** `add`: a word already saved is returned as it is, with `added: false`. */
const learn = defineAction({
	description:
		'Add a word to learn, due for review now: words/<word>.md with its meaning, reading, and examples. A word already saved is returned unchanged, with added false',
	input: {
		word: field.text({ description: 'The word or phrase, as written: 你好' }),
		meaning: field.text({ optional: true, description: 'What it means' }),
		reading: field.text({
			optional: true,
			description: 'How it is read or pronounced, such as pinyin, kana, or IPA',
		}),
		body: field.text({
			optional: true,
			description: 'Examples and notes, one example per line',
		}),
	},
	positional: ['word', 'meaning'],
	annotations: {
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	run: async ({ word, meaning, reading, body }) => {
		// `pathOf` names the file by the word as typed, NFC, trimmed, and with single spaces.
		let added = false;
		const file = await words.update({ path: words.pathOf({ word }) }, (found) => {
			added = found === undefined;
			if (found) return {};
			return {
				createdAt: localTime(),
				meaning: meaning?.trim() || undefined,
				reading: reading?.trim() || undefined,
				body: body?.trim() ? `${body.trim()}\n` : '',
			};
		});
		return { ...file, added };
	},
});

const review = defineAction({
	description:
		'Grade how well I remembered a word (again, hard, good, easy) and schedule its next review by SM-2. Returns the new schedule, and when each grade would make it due if it were reviewed again now',
	input: {
		path: field.text({ description: "The word's file: words/你好.md" }),
		grade: field.select(GRADES, {
			description:
				'again: forgot it; hard: barely; good: remembered; easy: instantly',
		}),
	},
	positional: ['path', 'grade'],
	annotations: { destructiveHint: false, openWorldHint: false },
	run: async ({ path, grade }) => {
		const now = new Date();
		// `update` calls this again when the word changed since it was read, so two
		// reviews at once both count; `scheduled` is the schedule it wrote.
		let scheduled!: Schedule;
		await words.update({ path }, (word) => {
			if (!word) throw new Error(`There is no ${path}`);
			scheduled = schedule(word, grade, now);
			return scheduled;
		});
		return { path, grade, ...scheduled, next: nextFor(scheduled, now) };
	},
});

const due = defineAction({
	description:
		'The words due for review now, with their meanings, readings, and examples: words reviewed before first, the most overdue first, then new words, oldest first. Each says when every grade would make it due next',
	input: {},
	annotations: { readOnlyHint: true, openWorldHint: false },
	run: async () => {
		const now = new Date();
		const order = (row: WordRow) =>
			row.due === undefined
				? ([1, instant(row.createdAt)] as const)
				: ([0, instant(row.due)] as const);
		const rows = (await words.list())
			.filter((row) => isDue(row, now))
			.sort((a, b) => {
				const [groupA, timeA] = order(a);
				const [groupB, timeB] = order(b);
				// Compared rather than subtracted: two words with no time are both Infinity.
				return (
					groupA - groupB || (timeA === timeB ? 0 : timeA < timeB ? -1 : 1)
				);
			});
		const found: DueWord[] = [];
		for (const row of rows) {
			const word = await words.get({ path: row.path });
			if (word) found.push({ ...word, next: nextFor(word, now) });
		}
		return found;
	},
});

export default defineApp({
	description:
		"Words I'm learning: a note per word, named by the word, with its meaning, its reading, examples in the body, and when to review it next",
	collections: { words },
	// One collection: its verbs are the app's own, `vocab add` rather than `vocab words add`.
	actions: { ...words.actions(), add: learn, review, due },
});

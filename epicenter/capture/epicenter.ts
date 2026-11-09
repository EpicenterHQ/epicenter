import {
	type Collection,
	collectionActions,
	defineApp,
	field,
	timeId,
} from '@epicenter/app';
import declaration from './epicenter.json';

/** `at` as RFC 3339 in this computer's offset: `2026-11-10T22:41:05+08:00`. */
function localTime(at: Date): string {
	const offset = -at.getTimezoneOffset();
	const sign = offset >= 0 ? '+' : '-';
	const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
	const local = new Date(at.getTime() + offset * 60_000).toISOString().slice(0, 19);
	return `${local}${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

/** How much of a capture's text `recent` returns. */
const PREVIEW = 280;

/** `captures get`, which reads a file's front matter the way every client does. */
const get = collectionActions(
	'captures',
	declaration.collections.captures as Collection,
)['captures get']!;

/**
 * What a list shows of a capture's body: its text, cut at `PREVIEW`
 * characters, and how many thoughts it has. A rough reading for a list, not
 * the body codec the view edits with: the text is everything before a
 * `## Thoughts` line, and a thought is a line under it that starts with a
 * bullet, up to the next heading.
 */
export function preview(body: string): { text: string; thoughts: number } {
	const heading = /^## Thoughts[ \t]*$/m.exec(body);
	const whole = (heading ? body.slice(0, heading.index) : body).trim();
	const text =
		whole.length > PREVIEW ? `${whole.slice(0, PREVIEW).trimEnd()}…` : whole;
	if (!heading) return { text, thoughts: 0 };
	const section = body.slice(heading.index + heading[0].length);
	const end = /^#{1,2}[ \t]/m.exec(section)?.index ?? section.length;
	const thoughts = section.slice(0, end).match(/^[-*+][ \t]/gm)?.length ?? 0;
	return { text, thoughts };
}

/** The moment `capturedAt` names, or -Infinity when it names none, so those sort last. */
function instant(capturedAt: string | undefined): number {
	const at = capturedAt === undefined ? Number.NaN : Date.parse(capturedAt);
	return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

const app = defineApp(declaration, {
	actions: {
		add: {
			description:
				'Capture something now: a new captures/<id>.md holding the text, its id made from the time',
			input: { text: field.text() },
			positional: ['text'],
			annotations: { destructiveHint: false, openWorldHint: false },
			async run({ text }, { folder }) {
				const at = new Date();
				const id = timeId(at);
				const capturedAt = localTime(at);
				const body = text.endsWith('\n') ? text : `${text}\n`;
				await folder.write(
					`captures/${id}.md`,
					`---\ncapturedAt: ${JSON.stringify(capturedAt)}\n---\n${body}`,
				);
				return { id, capturedAt };
			},
		},
		recent: {
			description:
				'The newest captures by capturedAt, at most `limit` (50 unless given), each as its id, capturedAt, the start of its text, and its number of thoughts. `matching` keeps only files that contain it, ignoring case; `total` counts every capture kept.',
			input: {
				limit: field.number({ optional: true }),
				matching: field.text({ optional: true }),
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
			async run({ limit = 50, matching }, context) {
				const needle = matching?.trim().toLowerCase() || undefined;
				const found: {
					id: string;
					capturedAt: string | undefined;
					body: string;
					at: number;
				}[] = [];
				for (const path of await context.folder.list('captures')) {
					const id = /^captures\/([^./\\][^/\\]*)\.md$/.exec(path)?.[1];
					if (id === undefined) continue;
					const read = (await get.run({ id }, context)) as {
						capturedAt?: unknown;
						body: string;
					};
					if (needle && !read.body.toLowerCase().includes(needle)) continue;
					const capturedAt =
						typeof read.capturedAt === 'string' ? read.capturedAt : undefined;
					found.push({ id, capturedAt, body: read.body, at: instant(capturedAt) });
				}
				// Newest first; ties, and captures with no date, by id, newest first.
				found.sort(
					(a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
				);
				return {
					total: found.length,
					captures: found
						.slice(0, Math.max(0, Math.floor(limit)))
						.map(({ id, capturedAt, body }) => ({ id, capturedAt, ...preview(body) })),
				};
			},
		},
	},
});

export default app;

/** What `recent` returns, for the view. */
export type Recent = Awaited<ReturnType<typeof app.actions.recent.run>>;

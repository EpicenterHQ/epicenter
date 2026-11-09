import { defineApp, field, timeId } from '@epicenter/app';
import declaration from './epicenter.json';

/** `at` as RFC 3339 in this computer's offset: `2026-11-10T22:41:05+08:00`. */
function localTime(at: Date): string {
	const offset = -at.getTimezoneOffset();
	const sign = offset >= 0 ? '+' : '-';
	const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
	const local = new Date(at.getTime() + offset * 60_000).toISOString().slice(0, 19);
	return `${local}${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

export default defineApp(declaration, {
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
	},
});

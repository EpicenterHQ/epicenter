/**
 * A note's text: the body its rich-text and Source views write, and the text
 * a list shows.
 *
 * The rich-text view and the Source view both replace the body in the whole
 * note through `withBody`.
 */
import { InstantString } from '@epicenter/definition';
import type { NoteFields } from './data.js';

/**
 * The complete note with `body` as its body, every field kept. A body that
 * changes moves an existing `updatedAt` to `now` and never adds the field.
 * The same body gives back `note` itself: nothing about the note changed.
 */
export function withBody<
	TNote extends { readonly fields: object; readonly body: string },
>(
	note: TNote,
	body: string,
	now: NoteFields['updatedAt'] = InstantString.now(),
): TNote {
	if (body === note.body) return note;
	const fields: object = note.fields;
	const dated = 'updatedAt' in fields && fields.updatedAt !== undefined;
	return {
		...note,
		fields: dated ? { ...fields, updatedAt: now } : fields,
		body,
	};
}

/** Plain text from the start of a Markdown body, for list previews. */
export function previewText(body: string | undefined, limit = 120): string {
	if (!body) return '';
	let text = '';
	for (const line of body.split(/\r?\n/)) {
		const plain = line
			.replace(
				/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/,
				'',
			)
			.replace(/[*_~`]/g, '')
			.trim();
		if (plain === '' || /^`{3}/.test(line.trim())) continue;
		text += text === '' ? plain : ` ${plain}`;
		if (text.length >= limit) break;
	}
	return text.slice(0, limit);
}

/** The name a person sees for a note: its title, else its first line of text. */
export function displayTitle(
	title: string | undefined,
	body: string | undefined,
): string {
	if (title !== undefined && title.trim() !== '') return title;
	return previewText(body, 60) || 'Untitled';
}

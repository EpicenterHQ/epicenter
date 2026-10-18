/** A note's text as a list shows it: its preview and the name a person sees. */

/** Plain text from the start of a Markdown body, for list previews. */
export function previewText(body: string | undefined, limit = 120): string {
	if (!body) return '';
	let text = '';
	for (const line of body.split('\n')) {
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

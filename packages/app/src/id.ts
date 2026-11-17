/** Why an id cannot name one Markdown file, without changing its bytes. */
export function idProblem(value: unknown): string | undefined {
	if (typeof value !== 'string' || value === '')
		return 'an id must be non-empty text';
	if (new TextEncoder().encode(value).length > 200)
		return 'an id must be at most 200 UTF-8 bytes';
	if (/[/\\]/.test(value)) return 'an id cannot contain / or \\';
	if (/\p{Cc}/u.test(value)) return 'an id cannot contain a control character';
	if (value.startsWith('.')) return 'an id cannot start with .';
	if (value.startsWith(' ') || value.endsWith(' '))
		return 'an id cannot start or end with a space';
	if (value.normalize('NFC') !== value) return 'an id must be Unicode NFC';
	return undefined;
}

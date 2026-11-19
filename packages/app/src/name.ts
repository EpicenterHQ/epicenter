/** What a name is, in the words an error gives. */
export const NAME_RULE =
	'lowercase letters, digits and dashes, starting with a letter';

/**
 * Whether `value` is a name: lowercase letters, digits and dashes, starting
 * with a letter. An app, an action and a data key are named so, which keeps
 * each one a safe command word, MCP tool part, route segment and folder.
 */
export function isName(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
}

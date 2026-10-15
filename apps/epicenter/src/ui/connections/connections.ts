/**
 * What Settings' AI connections share: the row's fields, how each kind is
 * named, the query key of a connection's keychain state, and a new
 * connection's id.
 */

import type { ConnectionKind } from '@epicenter/ai/send';
import type { CliError } from '../bindings.gen';

/** A `connections` row's fields, as `so.epicenter`'s declaration reads them. */
export type ConnectionFields = {
	kind: ConnectionKind;
	title: string;
	model: string;
};

export const KIND_LABELS: Record<ConnectionKind, string> = {
	'openai-compatible': 'OpenAI-compatible endpoint',
	epicenter: 'Epicenter account',
	local: 'This computer',
};

/** The query key of what the keychain holds for `stem`. */
export const keyStateKey = (stem: string) => ['ai-key-state', stem] as const;

/**
 * A new connection's id, which is its row's stem and its keychain name: the
 * title in lowercase letters, digits, and hyphens, numbered when taken.
 */
export function connectionId(title: string, taken: ReadonlySet<string>) {
	const base =
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'connection';
	let id = base;
	for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
	return id;
}

/** What a person is told when a key command did not run or was refused. */
export function failureText(error: CliError) {
	return error.name === 'NotGranted'
		? 'This window was not granted the folder.'
		: error.message;
}

/**
 * What Settings' AI connections share: how each kind is named, the query
 * key of the listing, a new connection's id, and what a person is told when
 * a key command fails.
 */

import type { AiConnectionKind, CliError } from '../bindings.gen';

export const KIND_LABELS: Record<AiConnectionKind, string> = {
	'openai-compatible': 'OpenAI-compatible endpoint',
	epicenter: 'Epicenter account',
	local: 'This computer',
};

/**
 * The kinds a new connection may have. `local` stays a kind a connection may
 * hold, and `epicenter send` refuses it (`LocalNotSent`), but no app sends
 * over it yet, so it is not offered.
 */
export const OFFERED_KINDS = [
	'openai-compatible',
	'epicenter',
] as const satisfies readonly AiConnectionKind[];

/** The query key of this computer's connections, as `ai_key_list` lists them. */
export const CONNECTIONS_KEY = ['ai-connections'] as const;

/**
 * A new connection's id, which names its entry and its keychain entry: the
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
		? 'This window may not change AI connections.'
		: error.message;
}

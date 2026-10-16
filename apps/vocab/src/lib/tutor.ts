/**
 * Where the tutor runs (ADR-0581). The learner's connections are rows of this
 * browser's `so.epicenter`, with each endpoint and key saved in this browser;
 * which one the tutor uses is `tutorConnection` in Vocab's own folder. With
 * none chosen, a signed-in learner gets Epicenter's hosted `VOCAB_MODEL`, and
 * no row is written for it.
 *
 * Every turn builds its client from what is saved now, so an endpoint edited
 * in another tab is the one the next turn uses. Dictation always uses the
 * hosted account; a chosen connection never changes where audio goes.
 */

import {
	accountEndpoint,
	type BrowserAccount,
	browserSecrets,
	connectionFetch,
} from '@epicenter/ai/browser';
import type { epicenterDefinition } from '@epicenter/ai/connection-table';
import { type Fetch, keyState, type SecretStore } from '@epicenter/ai/send';
import type { Folder } from '@epicenter/folder';
import OpenAI from 'openai';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { VOCAB_MODEL } from './data.js';

/** A turn's client and the model it names. */
export type TutorRoute = { client: OpenAI; model: string };

type Connections = Pick<Folder<typeof epicenterDefinition>, 'tables'>;

/** An OpenAI SDK client whose every request goes out through `fetch`. */
function clientOver(baseURL: string, fetch: Fetch) {
	return new OpenAI({
		baseURL,
		// The request's key, if any, is added below the SDK; this one is dropped.
		apiKey: 'sent-by-epicenter',
		dangerouslyAllowBrowser: true,
		maxRetries: 0,
		fetch,
	});
}

/** A client for Epicenter's hosted models, over the account's own `fetch`. */
export function hostedClient(account: BrowserAccount) {
	const endpoint = accountEndpoint(account);
	return clientOver(
		endpoint,
		connectionFetch({
			target: { kind: 'epicenter', connection: 'epicenter' },
			endpoint,
			account,
		}),
	);
}

/**
 * The route for `choice`, the stored `tutorConnection`: a row of `so.epicenter`
 * by its id, or, when unset, the hosted default. Answers why there is none in
 * the words the learner sees.
 */
export async function tutorRoute({
	choice: choiceResult,
	connections,
	account,
	secrets = browserSecrets(),
}: {
	/** The stored `tutorConnection`, or why Vocab's settings cannot say. */
	choice: Result<string | undefined, string>;
	connections: Connections | null;
	account: BrowserAccount | undefined;
	secrets?: SecretStore;
}): Promise<Result<TutorRoute, string>> {
	if (choiceResult.error !== null) return Err(choiceResult.error);
	const choice = choiceResult.data;
	if (!choice)
		return account
			? Ok({ client: hostedClient(account), model: VOCAB_MODEL })
			: Err(
					"Choose a connection for the tutor, or sign in for Epicenter's hosted models.",
				);
	if (!connections)
		return Err("This browser's connections did not open. Reload to try again.");
	const { data: stored, error } =
		await connections.tables.connections.get(choice);
	if (error !== null)
		return Err(`The tutor's connection does not read: ${error.message}`);
	if (stored === undefined)
		return Err('The connection the tutor used is gone. Choose another.');
	const { kind, title, model } = stored.row.fields;
	const name = title || choice;
	switch (kind) {
		case 'epicenter':
			return account
				? Ok({ client: hostedClient(account), model: model || VOCAB_MODEL })
				: Err(`${name} sends to your Epicenter account. Sign in to use it.`);
		case 'local':
			return Err(
				`${name} runs on a computer's local model, which a browser does not have.`,
			);
	}
	if (!model) return Err(`${name} names no model. Add one in Connections.`);
	const { data: saved, error: keyError } = await keyState(secrets, choice);
	if (keyError !== null) return Err(keyError.message);
	if (saved.state === 'missing')
		return Err(
			`${name} has no endpoint saved in this browser. Add one in Connections.`,
		);
	return Ok({
		client: clientOver(
			saved.endpoint,
			connectionFetch({
				target: {
					kind: 'openai-compatible',
					connection: choice,
					endpoint: saved.endpoint,
				},
				endpoint: saved.endpoint,
				secrets,
			}),
		),
		model,
	});
}

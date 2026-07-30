/**
 * @fileoverview How an unknown thrown value becomes one wire error.
 *
 * Both Epicenter data carriers answer a failed operation with a `name` and a
 * `message`: the browser worker's `{ type: 'error' }` frame and the desktop
 * host's `DesktopResponse`. Each client turns that pair back into an `Error`
 * whose `name` it restores, so the pair is the whole of what a caller learns
 * about why its operation failed.
 *
 * Filling it with `cause instanceof Error` alone is wrong here, because the
 * throw this boundary most often catches is not an `Error`. A bound Lens
 * reports storage and projection failures by throwing the tagged error object a
 * `defineErrors` factory produced, and those are frozen plain objects. Under an
 * `instanceof` test every one of them collapses to the name `Error` and the
 * message `[object Object]`: the variant that says which refusal happened is
 * erased, and the sentence written for the reader is replaced by nothing.
 *
 * So the name is read from whatever carries one, which covers both an `Error`
 * subclass and a tagged error, and the message comes from
 * `extractErrorMessage`, which already knows how to read each of them. A value
 * that carries no name at all still answers `Error`, because that is the most
 * this boundary can honestly say about it.
 */

import { extractErrorMessage } from 'wellcrafted/error';

/** One failed operation, as a data carrier reports it. */
export type ThrownErrorDescription = { name: string; message: string };

/** Describe an unknown thrown value for a carrier that reports name and message. */
export function describeThrownError(cause: unknown): ThrownErrorDescription {
	return {
		name:
			typeof cause === 'object' &&
			cause !== null &&
			'name' in cause &&
			typeof cause.name === 'string' &&
			cause.name.length > 0
				? cause.name
				: 'Error',
		message: extractErrorMessage(cause),
	};
}

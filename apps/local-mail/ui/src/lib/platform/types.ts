/**
 * What each `#platform/*` leaf must be, so a dropped leaf is a type error
 * rather than a build that silently runs the browser one.
 */

import type { AuthorizationRequest } from '@epicenter/local-mail/oauth';

/**
 * Sending a person to Google and getting them back.
 *
 * The two builds return by different routes, and that is the whole difference.
 * The web build leaves the page, so it also has to write down what it is
 * carrying; the `connected` route reads that back and redeems the code. The
 * desktop build never leaves: Google's consent screen may not open inside an
 * Epicenter WebView, and Google admits only a loopback redirect for a Desktop
 * client, so the browser that comes back is not the WebView that left. There
 * the host takes the answer and this page collects it, still holding the
 * verifier in memory.
 *
 * Carrying the request across the gap is the leaf's job either way, which is
 * why the whole request is the argument rather than just the URL to open.
 */
export type GmailAuthorization = {
	/**
	 * Open Google's consent screen, and answer with where Google sent the
	 * person back.
	 *
	 * The web leaf never resolves: the page is gone before it could.
	 */
	authorize(request: AuthorizationRequest, signal: AbortSignal): Promise<URL>;
};

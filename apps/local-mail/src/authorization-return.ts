/**
 * Where an authorization returns, on each build.
 *
 * The browser opens consent separately. `CALLBACK_PATH` relays the return URL
 * to the primary window, which retains the PKCE verifier and opened App.
 *
 * The desktop build cannot. Google refuses a custom URI scheme for a Desktop
 * OAuth client and admits only a loopback redirect, and an Epicenter app window
 * admits navigation only to the host's own origin, so the consent screen opens
 * in the person's browser and Google answers on the host's socket rather than
 * in the WebView that left. `PENDING_CALLBACK_PATH` is how the WebView gets
 * that answer back, and it exists only because those two refusals meet.
 *
 * Both ends read these, which is why they are here rather than spelled once in
 * the host's route table and once in the page.
 *
 * Neither path carries a credential. The host holds an opaque URL for one
 * collection and reads nothing out of it; the code is redeemed in the window
 * that holds the verifier, and the refresh token goes straight to
 * `app.secrets` from there (ADR-0310).
 */

/** Google's redirect target, relative to the base this build is served under. */
export const CALLBACK_PATH = 'connected';

/** Where the Mail window collects a callback the host is holding. */
export const PENDING_CALLBACK_PATH = '/api/mail/pending-callback';

/** What that route answers when a callback is waiting. */
export type PendingCallback = { callbackUrl: string };

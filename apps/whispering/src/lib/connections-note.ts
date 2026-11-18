/**
 * Where a connection's key is kept, and where its requests leave from, in
 * the person's words (`keysKept`): the Keychain and the app on the desktop,
 * this browser's storage and this tab in a browser.
 */
import { keysKept } from './app.js';

export const connectionsNote = () =>
	keysKept === 'keychain'
		? "A connection's key is kept in this computer's Keychain, never in your folder. Whispering reads it when a request needs it and sends the request itself, so any endpoint works, including one on this computer or your network."
		: `A connection's key is kept in this browser's storage for this site, where code running on the site can read it, and never in your folder. Its requests leave this browser tab, so its endpoint must allow requests from ${location.origin} (CORS).`;

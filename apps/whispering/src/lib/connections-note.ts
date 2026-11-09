/**
 * Where a connection's key is kept, and where its requests leave from, in
 * the person's words, by what the connections offer here
 * (`connectionsRelayed`): the shell keeps each key and sends each request,
 * or the page does.
 */
import { connectionsRelayed } from './app.js';

export const connectionsNote = () =>
	connectionsRelayed
		? "A connection's key is kept in this computer's credential store and added by Whispering as a request leaves this computer, so any endpoint works, including one on this computer or your network. Epicenter's models go through Epicenter's API."
		: `A connection's key is kept in this browser's storage for this site, where code running on the site can read it. Its requests leave this browser tab, so its endpoint must allow requests from ${location.origin} (CORS). Epicenter's models go through Epicenter's API and have no such limit.`;

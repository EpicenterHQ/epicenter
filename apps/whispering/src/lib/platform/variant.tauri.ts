/** `#platform/variant` in Whispering's desktop window. */
import type { Variant } from './types.js';

export const variant: Variant = 'desktop';

/** Where a connection's key is kept, and where its requests leave from, in the person's words. */
export const connectionsNote = () =>
	"A connection's key is kept in this computer's credential store and added by Whispering as a request leaves this computer, so any endpoint works, including one on this computer or your network. Epicenter's models go through Epicenter's API.";

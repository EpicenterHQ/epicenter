/**
 * Launch at login: whether the system opens Whispering when the person
 * logs in. Only the desktop app can ask (`autostart.rs`); a browser tab is
 * opened by the person. The system holds the answer, so nothing here is in
 * `settings.json`.
 */
import type { Result } from 'wellcrafted/result';

export type Autostart = {
	/** Whether this place can be opened at login at all. */
	available: boolean;
	/** Whether the system opens Whispering at login now. */
	enabled(): Promise<boolean>;
	/** Have the system open Whispering at login, or stop it. `message` says why it would not. */
	set(on: boolean): Promise<Result<undefined, { message: string }>>;
};

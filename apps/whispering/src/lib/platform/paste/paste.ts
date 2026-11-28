/**
 * Paste at the cursor: pressing the paste keys in whatever app is in
 * front, after the text is on the clipboard. Only the desktop app can
 * (`paste.rs`); a browser tab cannot press a key in another app.
 *
 * On a Mac it needs the Accessibility permission. `allowed` asks macOS each
 * time, since the person can grant or withdraw it while the app runs, and
 * `press` refuses without it rather than report a paste that did not land.
 */
import type { Result } from 'wellcrafted/result';

export type Paste = {
	/** Whether this place can paste into another app at all. */
	available: boolean;
	/** Whether a paste can land now: on a Mac, whether Accessibility is granted. */
	allowed(): Promise<boolean>;
	/** Open the place the person allows it: System Settings' Accessibility list. */
	ask(): Promise<void>;
	/** Press the paste keys in the app in front. `message` says why it could not. */
	press(): Promise<Result<undefined, { message: string }>>;
};

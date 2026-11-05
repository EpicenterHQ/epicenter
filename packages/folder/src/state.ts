/**
 * Where a folder's unfinished writes live: `.epicenter/` at its root.
 *
 * A file in `.epicenter/` is on its way somewhere. It finishes (moves to its
 * real path), or the next open recovers or removes it. Each kind of
 * unfinished write has a part named for the operation that owns it:
 *
 * - `saves/`: a save's bytes waiting to be renamed over its target, under a
 *   name `scratchName` makes. Always safe to delete when no app runs; the
 *   desktop shell's open removes ones an hour old (`sweep_scratch`), and so
 *   does this browser's store at its first call (`isStaleSave`).
 * - `recordings/<target path>`: a desktop recording, from its first sample
 *   until it stops or the next open recovers it. It may hold audio until the
 *   app opens once, so nothing sweeps it. Only the desktop shell writes
 *   here.
 *
 * `.epicenter` is a hidden path (`isHiddenPath`), so it is never a folder's
 * data: no watcher reports it and `epicenter sync` never commits it. This
 * module is the one place TypeScript spells the layout, as far as a page
 * writes it (`saves/`); the folder core's `state.rs` spells all of it, and
 * `fixtures/state-layout.json` holds both to it.
 */

/** The directory at the top of a folder that holds its unfinished writes. */
export const STATE_DIRECTORY = '.epicenter';

/** The part of `STATE_DIRECTORY` where a save stages its bytes. */
export const SAVES = 'saves';

/**
 * `.epicenter/saves` inside the directory at `root`, written with `/`: on
 * the root's own file system, so a staged save's rename over its path is one
 * step.
 */
export const savesDirectory = (root: string) =>
	`${root}/${STATE_DIRECTORY}/${SAVES}`;

/**
 * This process's id in the names it stages under, so two never pick one
 * name. Made at the first stage, not at import.
 */
let engine: string | undefined;
let staged = 0;

/**
 * A new staged file's name: its creation time and a per-process counter in
 * base 36, around this process's id. The desktop shell's sweep reads a
 * name of this shape, and only this shape, for its age (`is_stale_scratch`
 * in the folder core), so a save a crash stopped is removed at its next
 * open; `isStaleSave` reads it the same way.
 */
export const scratchName = () => {
	engine ??= crypto.randomUUID().replaceAll('-', '');
	return `${Date.now().toString(36)}-${engine}-${(staged++).toString(36)}`;
};

/** How old a staged file must be before it is swept: its writer stopped. */
const STALE_SAVE_MS = 60 * 60 * 1000;

const STAGED_NAME = /^([0-9a-z]+)-[0-9a-f]{32}-[0-9a-z]+$/;

/**
 * Whether the staged file `name` was made more than an hour before `now`,
 * as the folder core's `is_stale_scratch` reads it. A name no host made is
 * never stale.
 */
export function isStaleSave(name: string, now: number): boolean {
	const time = STAGED_NAME.exec(name)?.[1];
	if (time === undefined) return false;
	const created = Number.parseInt(time, 36);
	return Number.isSafeInteger(created) && now - created > STALE_SAVE_MS;
}

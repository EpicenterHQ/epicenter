/**
 * Where a folder's unfinished writes live: `.epicenter/` at its root.
 *
 * A file in `.epicenter/` is on its way somewhere. It finishes (moves to its
 * real path), or the next open recovers or removes it. Each kind of
 * unfinished write has a part named for the operation that owns it:
 *
 * - `saves/`: a save's bytes waiting to be renamed over its target, under a
 *   name `scratchName` makes. Always safe to delete when no app runs; the
 *   desktop shell's open removes ones an hour old (`sweep_scratch`).
 * - `recordings/<target path>`: a desktop recording, from its first sample
 *   until it stops or the next open recovers it. It may hold audio until the
 *   app opens once, so nothing sweeps it. Only the desktop shell writes
 *   here.
 *
 * `.epicenter` is a hidden path (`isHiddenPath`), so it is never a folder's
 * data: no watcher reports it and `epicenter sync` never commits it. This
 * module is the one place TypeScript spells the layout, as far as a page
 * writes it (`saves/`); the folder core's `state.rs` spells all of it, and
 * `fixtures/state-layout.json` holds both to it. The OPFS worker, which
 * imports nothing, keeps its own copy of `.epicenter/saves`, held to the
 * same fixture.
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
 * open. The OPFS worker, which imports nothing, names its own the same way
 * (`stagedName`).
 */
export const scratchName = () => {
	engine ??= crypto.randomUUID().replaceAll('-', '');
	return `${Date.now().toString(36)}-${engine}-${(staged++).toString(36)}`;
};

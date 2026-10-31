/**
 * Where a folder's unfinished writes live: `.epicenter/` at its root.
 *
 * A file in `.epicenter/` is on its way somewhere. It finishes (moves to its
 * real path), or the next open recovers or removes it. Each kind of
 * unfinished write has a part named for the operation that owns it:
 *
 * - `saves/`: a save's bytes waiting to be renamed over its target, and a
 *   stopped desktop recording being encoded before it is placed. Always
 *   safe to delete when no app runs; opening a folder removes stale ones
 *   (`sweepStaleScratch`).
 * - `recordings/<target path>`: a desktop recording, from its first sample
 *   until it stops or the next open recovers it. It may hold audio until the
 *   app opens once, so nothing sweeps it. Only the desktop shell writes
 *   here.
 *
 * `.epicenter` is a hidden path (`isHiddenPath`), so it is never a folder's
 * data: no watcher reports it and `epicenter sync` never commits it. This
 * module is the one place TypeScript spells the layout; the folder core's
 * `state.rs` is the other, and `fixtures/state-layout.json` holds both to
 * it. The OPFS worker, which imports nothing, keeps its own copy of
 * `.epicenter/saves`, held to the same fixture.
 */

/** The directory at the top of a folder that holds its unfinished writes. */
export const STATE_DIRECTORY = '.epicenter';

/** The part of `STATE_DIRECTORY` where a save stages its bytes. */
export const SAVES = 'saves';

/**
 * The part of `STATE_DIRECTORY` where a desktop recording is written while
 * it records, at its own folder-relative path.
 */
export const RECORDINGS = 'recordings';

/**
 * `.epicenter/saves` inside the directory at `root`, written with `/` as the
 * directory storage writes its own paths: on the root's own file system, so
 * a staged save's rename over its path is one step.
 */
export const savesDirectory = (root: string) =>
	`${root}/${STATE_DIRECTORY}/${SAVES}`;

/**
 * The folder-relative path the desktop shell writes the recording of the
 * folder-relative `stem` (its path without an extension) to while it
 * records: `.epicenter/recordings/<stem>.wav` (`state::recording`).
 */
export const recordingPath = (stem: string) =>
	`${STATE_DIRECTORY}/${RECORDINGS}/${stem}.wav`;

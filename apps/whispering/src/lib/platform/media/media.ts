/**
 * Music and video playing on the computer, paused for a take and resumed
 * after it. Only the desktop app can (`media.rs`); a browser tab pauses
 * nothing.
 *
 * `pause` answers what it paused, as tokens only `resume` reads. Resume
 * plays only those, so something the person had paused themself stays
 * paused. Neither ever fails a take: a system that will not pause is left
 * playing.
 */
export type Media = {
	/** Pause what is playing now; answers what to hand `resume`. */
	pause(): Promise<string[]>;
	/** Play again what `pause` paused. */
	resume(paused: string[]): Promise<void>;
};

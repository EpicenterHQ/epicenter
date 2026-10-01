import { foldMicLevel } from '$lib/recording-pill/level.js';

let level = $state(0);

export const recordingMicLevel = {
	get current() {
		return level;
	},
};

/** The browser indicator reads its level in the same application document. */
export function reportRecordingMicLevel(rawRms: number): void {
	level = foldMicLevel(level, rawRms);
}

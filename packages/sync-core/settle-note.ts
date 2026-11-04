// Relative, not `@epicenter/definition/merge`: the spike adds no workspace
// package, so the lockfile stays as it is.
import { settle } from '../definition/src/merge/index.ts';

/** One note both sides changed, as the core hands it to the host. */
export type SettleInput = {
	path: string;
	base?: string;
	current: string;
	incoming: string;
	currentAuthor: string;
	currentTime: string;
	incomingAuthor: string;
	incomingTime: string;
};

/** `settle` as the core calls it: the merged text of one note. */
export function settleNote(input: SettleInput): string {
	const settled = settle(input.base ?? null, input.current, input.incoming, {
		parties: {
			current: { author: input.currentAuthor, time: input.currentTime },
			incoming: { author: input.incomingAuthor, time: input.incomingTime },
		},
	});
	return settled.text ?? input.current;
}

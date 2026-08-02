// The shared triage-action seam. One place turns a triage intent plus a
// message's current Gmail labels into the concrete `{addLabels, removeLabels}`
// assertion the `/api/accounts/:account/messages/assert` route records, and its
// inverse. Both the MessageDetail toolbar and the page-level keyboard handler
// plan actions here, so buttons and keys fire the exact same act; the undo
// affordance is just the inverse of what was fired.
//
// Pure and Svelte-free on purpose: the mutation, the read-only gate, and the
// toast live at the page (their single owner), and this stays unit-testable.

export type TriageAction = {
	/** Past-tense verb for the toast, e.g. "Archived". */
	label: string;
	addLabels: string[];
	removeLabels: string[];
};

/** The reversible core verbs, shared by the toolbar and the keyboard. Each is a
 * toggle keyed off one pivot label, so the direction (and its human label) is
 * derived from whether that label is currently present. */
export type ToggleVerb = 'inbox' | 'read' | 'star';

export function planToggle(labelIds: string[], verb: ToggleVerb): TriageAction {
	const has = (id: string) => labelIds.includes(id);
	switch (verb) {
		case 'inbox':
			return has('INBOX')
				? { label: 'Archived', addLabels: [], removeLabels: ['INBOX'] }
				: { label: 'Moved to inbox', addLabels: ['INBOX'], removeLabels: [] };
		case 'read':
			return has('UNREAD')
				? { label: 'Marked read', addLabels: [], removeLabels: ['UNREAD'] }
				: { label: 'Marked unread', addLabels: ['UNREAD'], removeLabels: [] };
		case 'star':
			return has('STARRED')
				? { label: 'Unstarred', addLabels: [], removeLabels: ['STARRED'] }
				: { label: 'Starred', addLabels: ['STARRED'], removeLabels: [] };
	}
}

/** Moving to trash is an ordinary assertion, not a Gmail endpoint the UI has to
 * know about: it adds `TRASH` like any other label, and its Undo is the inverse
 * that removes it. Fixed rather than a toggle because the trash button only ever
 * points one way; restoring happens from the Trash view's own labels. */
export const MOVE_TO_TRASH: TriageAction = {
	label: 'Moved to trash',
	addLabels: ['TRASH'],
	removeLabels: [],
};

/** Add or remove one Gmail label by id. `name` is the already-resolved display
 * name (the caller has the label list); this stays free of the format layer. */
export function planLabel(
	labelId: string,
	name: string,
	present: boolean,
): TriageAction {
	return present
		? { label: `Removed ${name}`, addLabels: [], removeLabels: [labelId] }
		: { label: `Added ${name}`, addLabels: [labelId], removeLabels: [] };
}

/** The inverse action, for Undo: swap add and remove. The write core is
 * symmetric, so the inverse of `{addLabels:['INBOX']}` is
 * `{removeLabels:['INBOX']}`; the label is carried through unchanged (the undo
 * path fires silently, so it is never shown). */
export function invert(action: TriageAction): TriageAction {
	return {
		label: action.label,
		addLabels: action.removeLabels,
		removeLabels: action.addLabels,
	};
}

/** Whether an action touches any label, i.e. has a meaningful inverse. A plan
 * that adds and removes nothing is a no-op and earns no Undo toast. */
export function isReversible(action: TriageAction): boolean {
	return action.addLabels.length > 0 || action.removeLabels.length > 0;
}

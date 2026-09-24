// Toolbar and keyboard share label-choice planning. The page owns recording,
// reconciliation, and Undo; the outbox uses the same label vocabulary.

export type TriageAction = {
	/** Past-tense verb for the toast, e.g. "Archived". */
	label: string;
	labelId: string;
	want: boolean;
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
				? { label: 'Archived', labelId: 'INBOX', want: false }
				: { label: 'Moved to inbox', labelId: 'INBOX', want: true };
		case 'read':
			return has('UNREAD')
				? { label: 'Marked read', labelId: 'UNREAD', want: false }
				: { label: 'Marked unread', labelId: 'UNREAD', want: true };
		case 'star':
			return has('STARRED')
				? { label: 'Unstarred', labelId: 'STARRED', want: false }
				: { label: 'Starred', labelId: 'STARRED', want: true };
	}
}

/** Moving to trash is an ordinary assertion, not a Gmail endpoint the UI has to
 * know about: it adds `TRASH` like any other label, and its Undo is the inverse
 * that removes it. Fixed rather than a toggle because the trash button only ever
 * points one way; restoring happens from the Trash view's own labels. */
export const MOVE_TO_TRASH: TriageAction = {
	label: 'Moved to trash',
	labelId: 'TRASH',
	want: true,
};

/** Add or remove one Gmail label by id. `name` is the already-resolved display
 * name (the caller has the label list); this stays free of the format layer. */
export function planLabel(
	labelId: string,
	name: string,
	present: boolean,
): TriageAction {
	return present
		? { label: `Removed ${name}`, labelId, want: false }
		: { label: `Added ${name}`, labelId, want: true };
}

/** Undo records the opposite choice on the captured message and account. */
export function invert(action: TriageAction): TriageAction {
	return { ...action, want: !action.want };
}

/**
 * The other direction: name an assertion already recorded, the way the person
 * who made it would.
 *
 * `planToggle` turns a verb into a label choice, and this turns one back into a
 * verb, which is what the outbox lists. Both are here so the two vocabularies
 * cannot drift: "Archive" has to mean removing `INBOX` in both directions or a
 * person is told their archive is a different act than the one they made.
 *
 * Present tense, because an outbox row is work that has not happened yet.
 * `planToggle`'s labels are past tense for the opposite reason.
 */
export function describeAssertion(
	labelId: string,
	want: boolean,
	/** The label's display name, when the caller has the label list. */
	name = labelId,
): string {
	if (labelId === 'INBOX') return want ? 'Move to inbox' : 'Archive';
	if (labelId === 'TRASH') return want ? 'Move to trash' : 'Restore from trash';
	if (labelId === 'UNREAD') return want ? 'Mark unread' : 'Mark read';
	if (labelId === 'STARRED') return want ? 'Star' : 'Unstar';
	return want ? `Add ${name}` : `Remove ${name}`;
}

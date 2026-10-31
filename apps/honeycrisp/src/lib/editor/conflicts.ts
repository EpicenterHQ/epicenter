/**
 * Conflict blocks as cards. When two writers' edits of a note's body
 * overlap, the merge writes one conflict block per clash into the note
 * (decisions 15 and 24; the grammar is `findConflicts` in
 * `@epicenter/definition/merge`). Each well-formed block renders as one
 * card in place of its lines, offering Keep this (the side already there),
 * Keep that (the side that arrived after it) and Keep both; choosing is one
 * edit that replaces the whole block, so the markers are gone and Undo
 * brings them back.
 */
import { type EditorState, type Range, StateField } from '@codemirror/state';
import {
	Decoration,
	type DecorationSet,
	EditorView,
	WidgetType,
} from '@codemirror/view';
import { findConflicts } from '@epicenter/definition/merge';

type Conflict = {
	from: number;
	to: number;
	current: string;
	incoming: string;
	/** Who wrote each side, as the block labels it. */
	labels: [string, string];
};

/** Every well-formed conflict block, with document positions (a line break counts once). */
export function conflictsIn(state: EditorState): Conflict[] {
	const text = state.doc.sliceString(0, state.doc.length, '\n');
	return findConflicts(text).map(
		({ from, to, current, incoming, labels, sides }) => ({
			from,
			to,
			current,
			incoming,
			// A label Epicenter wrote names its author; any other is shown as written.
			labels: [
				sides.current?.author ?? labels.current,
				sides.incoming?.author ?? labels.incoming,
			],
		}),
	);
}

export type Resolution = 'this' | 'that' | 'both';

/** What a block reads as once resolved. */
export function resolved(
	conflict: Pick<Conflict, 'current' | 'incoming'>,
	choice: Resolution,
) {
	if (choice === 'this') return conflict.current;
	if (choice === 'that') return conflict.incoming;
	return conflict.current + conflict.incoming;
}

/** Replace the block starting at `from` with the chosen side, as one edit. */
export function resolveConflict(
	view: EditorView,
	from: number,
	choice: Resolution,
) {
	const conflict = conflictsIn(view.state).find(
		(candidate) => candidate.from === from,
	);
	if (conflict === undefined) return false;
	const separator = view.state.lineBreak;
	view.dispatch({
		changes: {
			from: conflict.from,
			to: conflict.to,
			insert: resolved(conflict, choice).split('\n').join(separator),
		},
		selection: { anchor: conflict.from },
		userEvent: 'input.resolve',
	});
	return true;
}

class ConflictCard extends WidgetType {
	constructor(readonly conflict: Conflict) {
		super();
	}
	override eq(other: ConflictCard) {
		const [a, b] = [this.conflict, other.conflict];
		return (
			a.current === b.current &&
			a.incoming === b.incoming &&
			a.labels.join() === b.labels.join()
		);
	}
	toDOM(view: EditorView) {
		const card = document.createElement('div');
		card.className = 'cm-conflict';
		card.setAttribute('role', 'group');
		card.setAttribute('aria-label', 'Overlapping edits');
		const title = document.createElement('p');
		title.className = 'cm-conflict-title';
		title.textContent = 'These edits overlap. Keep one, or both.';
		card.append(title);
		const sides: [string, string][] = [
			[this.conflict.labels[0] || 'This', this.conflict.current],
			[this.conflict.labels[1] || 'That', this.conflict.incoming],
		];
		for (const [label, text] of sides) {
			const side = document.createElement('div');
			side.className = 'cm-conflict-side';
			const name = document.createElement('p');
			name.className = 'cm-conflict-label';
			name.textContent = label;
			const body = document.createElement('pre');
			body.textContent = text;
			side.append(name, body);
			card.append(side);
		}
		const actions = document.createElement('div');
		actions.className = 'cm-conflict-actions';
		for (const [choice, text] of [
			['this', 'Keep this'],
			['that', 'Keep that'],
			['both', 'Keep both'],
		] as const) {
			const button = document.createElement('button');
			button.type = 'button';
			button.textContent = text;
			button.addEventListener('mousedown', (event) => event.preventDefault());
			button.addEventListener('click', () =>
				resolveConflict(view, view.posAtDOM(card), choice),
			);
			actions.append(button);
		}
		card.append(actions);
		return card;
	}
	override ignoreEvent() {
		return true;
	}
}

function cards(state: EditorState): DecorationSet {
	const found: Range<Decoration>[] = conflictsIn(state).map((conflict) => {
		// A block decoration covers whole lines: up to the closing marker's line end.
		const end = state.doc.lineAt(conflict.to - 1).to;
		return Decoration.replace({
			widget: new ConflictCard(conflict),
			block: true,
		}).range(conflict.from, end);
	});
	return Decoration.set(found);
}

const field = StateField.define<DecorationSet>({
	create: cards,
	update: (value, transaction) =>
		transaction.docChanged ? cards(transaction.state) : value,
	provide: (self) => [
		EditorView.decorations.from(self),
		EditorView.atomicRanges.of((view) => view.state.field(self)),
	],
});

const theme = EditorView.baseTheme({
	'.cm-conflict': {
		margin: '0.5em 0',
		padding: '0.6em 0.75em',
		border: '1px solid rgb(234 179 8 / 0.6)',
		borderRadius: '8px',
		backgroundColor: 'rgb(234 179 8 / 0.08)',
		fontFamily: 'inherit',
		whiteSpace: 'normal',
	},
	'.cm-conflict-title': {
		margin: '0 0 0.4em',
		fontWeight: '600',
		fontSize: '0.9em',
	},
	'.cm-conflict-side': { margin: '0.3em 0' },
	'.cm-conflict-label': { margin: '0', fontSize: '0.75em', opacity: '0.7' },
	'.cm-conflict-side pre': {
		margin: '0.1em 0 0',
		whiteSpace: 'pre-wrap',
		fontFamily: 'inherit',
	},
	'.cm-conflict-actions': { display: 'flex', gap: '0.5em', marginTop: '0.5em' },
	'.cm-conflict-actions button': {
		font: 'inherit',
		fontSize: '0.85em',
		padding: '0.15em 0.6em',
		borderRadius: '6px',
		border: '1px solid rgb(127 127 127 / 0.4)',
		background: 'transparent',
		color: 'inherit',
		cursor: 'pointer',
	},
});

/** Conflict blocks render as cards; the cursor steps over them. */
export const conflictCards = [field, theme];

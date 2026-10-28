/**
 * Live preview over the Markdown text: headings, emphasis, strikethrough,
 * inline code and links render in place, and a task's `[ ]` is a checkbox
 * that toggles the character inside it, in place of its bullet. The text is never changed to show
 * this; the syntax is hidden with decorations, and on any line a selection
 * touches it is shown, so a person edits the Markdown they see. Images and
 * tables show as plain Markdown.
 */
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';

const hidden = Decoration.replace({});
const styles: Record<string, Decoration> = {
	StrongEmphasis: Decoration.mark({ class: 'cm-md-strong' }),
	Emphasis: Decoration.mark({ class: 'cm-md-em' }),
	Strikethrough: Decoration.mark({ class: 'cm-md-strike' }),
	InlineCode: Decoration.mark({ class: 'cm-md-code' }),
	Link: Decoration.mark({ class: 'cm-md-link' }),
};
const headings = [1, 2, 3, 4, 5, 6].map((level) => Decoration.line({ class: `cm-md-heading cm-md-h${level}` }));

/** The checkbox a task's `[ ]` or `[x]` shows as. Clicking it toggles that one character. */
class TaskBox extends WidgetType {
	constructor(readonly checked: boolean) {
		super();
	}
	override eq(other: TaskBox) {
		return other.checked === this.checked;
	}
	toDOM(view: EditorView) {
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.className = 'cm-md-task';
		box.checked = this.checked;
		box.setAttribute('aria-label', this.checked ? 'Done task' : 'Open task');
		// The editor keeps focus and the selection; the click is the edit.
		box.addEventListener('mousedown', (event) => event.preventDefault());
		box.addEventListener('click', (event) => {
			event.preventDefault();
			const at = view.posAtDOM(box);
			const marker = view.state.sliceDoc(at, at + 3);
			if (!/^\[[ xX]\]$/.test(marker)) return;
			view.dispatch({
				changes: { from: at + 1, to: at + 2, insert: marker[1] === ' ' ? 'x' : ' ' },
				userEvent: 'input.toggle',
			});
		});
		return box;
	}
	override ignoreEvent() {
		return false;
	}
}

/** The line numbers any selection range touches, where the syntax shows. */
function activeLines(state: EditorState) {
	const lines = new Set<number>();
	for (const range of state.selection.ranges) {
		const last = state.doc.lineAt(range.to).number;
		for (let line = state.doc.lineAt(range.from).number; line <= last; line++) lines.add(line);
	}
	return lines;
}

function decorate(view: EditorView): DecorationSet {
	const { state } = view;
	const active = activeLines(state);
	const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number);
	const found: Range<Decoration>[] = [];
	const hide = (from: number, to: number) => {
		if (from < to && !isActive(from)) found.push(hidden.range(from, to));
	};
	for (const { from, to } of view.visibleRanges) {
		syntaxTree(state).iterate({
			from,
			to,
			enter(node) {
				const name = node.name;
				const level = /^ATXHeading([1-6])$/.exec(name)?.[1];
				if (level !== undefined) {
					found.push(headings[Number(level) - 1]!.range(state.doc.lineAt(node.from).from));
					return;
				}
				const style = styles[name];
				if (style !== undefined && node.from < node.to) found.push(style.range(node.from, node.to));
				switch (name) {
					case 'HeaderMark': {
						// The opening marks take the space after them; closing ones the space before.
						const after = state.sliceDoc(node.to, node.to + 1) === ' ' ? 1 : 0;
						const before = node.from > 0 && state.sliceDoc(node.from - 1, node.from) === ' ' && after === 0 ? 1 : 0;
						hide(node.from - before, node.to + after);
						return;
					}
					case 'EmphasisMark':
					case 'StrikethroughMark':
						hide(node.from, node.to);
						return;
					case 'CodeMark':
						if (node.node.parent?.name === 'InlineCode') hide(node.from, node.to);
						return;
					case 'LinkMark':
					case 'URL':
						if (node.node.parent?.name === 'Link') hide(node.from, node.to);
						return;
					case 'ListMark': {
						// A task's checkbox stands in for its bullet.
						const item = node.node.parent;
						if (item?.name === 'ListItem' && item.getChild('Task') !== null)
							hide(node.from, state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to);
						return;
					}
					case 'TaskMarker': {
						if (isActive(node.from)) return;
						const checked = /x/i.test(state.sliceDoc(node.from + 1, node.from + 2));
						found.push(Decoration.replace({ widget: new TaskBox(checked) }).range(node.from, node.to));
						return;
					}
				}
			},
		});
	}
	return Decoration.set(found, true);
}

const preview = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = decorate(view);
		}
		update(update: ViewUpdate) {
			if (update.docChanged || update.selectionSet || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState))
				this.decorations = decorate(update.view);
		}
	},
	{ decorations: (plugin) => plugin.decorations },
);

const theme = EditorView.baseTheme({
	'.cm-md-heading': { fontWeight: '600', lineHeight: '1.3' },
	'.cm-md-h1': { fontSize: '1.6em' },
	'.cm-md-h2': { fontSize: '1.35em' },
	'.cm-md-h3': { fontSize: '1.2em' },
	'.cm-md-h4, .cm-md-h5, .cm-md-h6': { fontSize: '1.05em' },
	'.cm-md-strong': { fontWeight: '700' },
	'.cm-md-em': { fontStyle: 'italic' },
	'.cm-md-strike': { textDecoration: 'line-through' },
	'.cm-md-code': { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '0.9em', borderRadius: '3px', padding: '0 2px', backgroundColor: 'rgb(127 127 127 / 0.15)' },
	'.cm-md-link': { textDecoration: 'underline', textUnderlineOffset: '2px' },
	'.cm-md-task': { margin: '0 0.35em 0 0', verticalAlign: 'middle', cursor: 'pointer' },
});

/** Live preview: rendered Markdown, with the syntax of the lines being edited shown. */
export const livePreview = [preview, theme];

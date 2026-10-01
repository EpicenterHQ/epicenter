<script lang="ts">
	import { Separator } from '@epicenter/ui/separator';
	import { Toggle } from '@epicenter/ui/toggle';
	import * as ToggleGroup from '@epicenter/ui/toggle-group';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import {
		configureYProsemirror,
		redo,
		syncPlugin,
		undo,
		yUndoPlugin,
	} from '@y/prosemirror';
	import * as Y from '@y/y';
	import BoldIcon from '@lucide/svelte/icons/bold';
	import Heading1Icon from '@lucide/svelte/icons/heading-1';
	import Heading2Icon from '@lucide/svelte/icons/heading-2';
	import Heading3Icon from '@lucide/svelte/icons/heading-3';
	import ItalicIcon from '@lucide/svelte/icons/italic';
	import ListIcon from '@lucide/svelte/icons/list';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import ListOrderedIcon from '@lucide/svelte/icons/list-ordered';
	import QuoteIcon from '@lucide/svelte/icons/quote';
	import StrikethroughIcon from '@lucide/svelte/icons/strikethrough';
	import UnderlineIcon from '@lucide/svelte/icons/underline';
	import {
		baseKeymap,
		chainCommands,
		lift,
		setBlockType,
		toggleMark,
		wrapIn,
	} from 'prosemirror-commands';
	import {
		ellipsis,
		emDash,
		inputRules,
		smartQuotes,
		textblockTypeInputRule,
		wrappingInputRule,
	} from 'prosemirror-inputrules';
	import { keymap } from 'prosemirror-keymap';
	import { type MarkType, type NodeType } from 'prosemirror-model';
	import {
		liftListItem,
		sinkListItem,
		splitListItem,
		wrapInList,
	} from 'prosemirror-schema-list';
	import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
	import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
	import 'prosemirror-view/style/prosemirror.css';

	// The same instance the Markdown codec and `derive` read through. This view
	// used to construct its own copy of the identical spec, which meant a node
	// added here and not there would render into the artifact as nothing, with
	// no error and no test able to see it (ADR-0289).
	import { noteSchema as schema } from './schema.js';

	function markActive(state: EditorState, markType: MarkType): boolean {
		const { from, $from: resolvedFrom, to, empty } = state.selection;
		if (empty)
			return !!markType.isInSet(state.storedMarks || resolvedFrom.marks());
		return state.doc.rangeHasMark(from, to, markType);
	}

	function nodeActive(
		state: EditorState,
		nodeType: NodeType,
		attrs?: Record<string, unknown>,
	): boolean {
		const { $from: resolvedFrom } = state.selection;

		for (let depth = resolvedFrom.depth; depth >= 0; depth -= 1) {
			const node = resolvedFrom.node(depth);
			if (node.type !== nodeType) continue;
			if (!attrs) return true;
			if (Object.entries(attrs).every(([key, val]) => node.attrs[key] === val))
				return true;
		}

		return false;
	}

	function createPlaceholderPlugin(text: string) {
		return new Plugin({
			props: {
				decorations(state) {
					const { doc } = state;
					if (
						doc.childCount === 1 &&
						doc.firstChild?.isTextblock &&
						doc.firstChild.content.size === 0
					) {
						return DecorationSet.create(doc, [
							Decoration.node(0, doc.firstChild.nodeSize, {
								class: 'is-editor-empty',
								'data-placeholder': text,
							}),
						]);
					}
					return DecorationSet.empty;
				},
			},
		});
	}

	function createTaskItemPlugin() {
		return new Plugin({
			props: {
				handleClickOn(view, _pos, node, nodePos, event) {
					if (node.type !== schema.nodes.taskItem) return false;
					const target = event.target;
					if (
						!(target instanceof HTMLInputElement) ||
						target.type !== 'checkbox'
					)
						return false;
					event.preventDefault();
					view.dispatch(
						view.state.tr.setNodeMarkup(nodePos, undefined, {
							...node.attrs,
							checked: !node.attrs.checked,
						}),
					);
					return true;
				},
			},
		});
	}

	function updateActiveFormats(state: EditorState) {
		activeFormats = {
			bold: markActive(state, schema.marks.strong!),
			italic: markActive(state, schema.marks.em!),
			underline: markActive(state, schema.marks.underline!),
			strike: markActive(state, schema.marks.strike!),
			heading1: nodeActive(state, schema.nodes.heading!, { level: 1 }),
			heading2: nodeActive(state, schema.nodes.heading!, { level: 2 }),
			heading3: nodeActive(state, schema.nodes.heading!, { level: 3 }),
			bulletList: nodeActive(state, schema.nodes.bullet_list!),
			orderedList: nodeActive(state, schema.nodes.ordered_list!),
			taskList: nodeActive(state, schema.nodes.taskList!),
			blockquote: nodeActive(state, schema.nodes.blockquote!),
		};
	}

	let {
		yxmlfragment,
		focusRequest,
	}: {
		yxmlfragment: Y.Node;
		focusRequest: number;
	} = $props();

	let element: HTMLDivElement | undefined = $state();
	let view: EditorView | undefined = $state();
	let activeFormats = $state.raw({
		bold: false,
		italic: false,
		underline: false,
		strike: false,
		heading1: false,
		heading2: false,
		heading3: false,
		bulletList: false,
		orderedList: false,
		taskList: false,
		blockquote: false,
	});

	const activeHeading = $derived.by(() => {
		if (activeFormats.heading1) return 'h1';
		if (activeFormats.heading2) return 'h2';
		if (activeFormats.heading3) return 'h3';
		return '';
	});

	const activeListType = $derived.by(() => {
		if (activeFormats.bulletList) return 'bullet';
		if (activeFormats.orderedList) return 'ordered';
		if (activeFormats.taskList) return 'task';
		return '';
	});

	$effect(() => {
		if (!element) return;

		let currentView: EditorView;
		const undoManager = new Y.UndoManager(yxmlfragment);

		currentView = new EditorView(element, {
			state: EditorState.create({
				schema,
				plugins: [
					syncPlugin(),
					yUndoPlugin(undoManager),
					createPlaceholderPlugin('Start writing…'),
					createTaskItemPlugin(),
					keymap({
						'Mod-z': undo,
						'Mod-y': redo,
						'Mod-Shift-z': redo,
						'Mod-b': toggleMark(schema.marks.strong!),
						'Mod-i': toggleMark(schema.marks.em!),
						'Mod-u': toggleMark(schema.marks.underline!),
						'Mod-Shift-s': toggleMark(schema.marks.strike!),
						'Mod-Shift-b': () => {
							if (nodeActive(currentView.state, schema.nodes.blockquote!)) {
								return lift(currentView.state, currentView.dispatch);
							}
							return wrapIn(schema.nodes.blockquote!)(
								currentView.state,
								currentView.dispatch,
							);
						},
						Enter: chainCommands(
							splitListItem(schema.nodes.taskItem!),
							splitListItem(schema.nodes.list_item!),
							baseKeymap.Enter!,
						),
						'Mod-]': (state, dispatch) =>
							sinkListItem(schema.nodes.taskItem!)(state, dispatch) ||
							sinkListItem(schema.nodes.list_item!)(state, dispatch),
						Tab: (state, dispatch) =>
							sinkListItem(schema.nodes.taskItem!)(state, dispatch) ||
							sinkListItem(schema.nodes.list_item!)(state, dispatch),
						'Mod-[': (state, dispatch) =>
							liftListItem(schema.nodes.taskItem!)(state, dispatch) ||
							liftListItem(schema.nodes.list_item!)(state, dispatch),
						'Shift-Tab': (state, dispatch) =>
							liftListItem(schema.nodes.taskItem!)(state, dispatch) ||
							liftListItem(schema.nodes.list_item!)(state, dispatch),
					}),
					keymap(baseKeymap),
					inputRules({
						rules: [
							...smartQuotes,
							emDash,
							ellipsis,
							textblockTypeInputRule(
								/^(#{1,3})\s$/,
								schema.nodes.heading!,
								(match) => ({
									level: match[1]!.length,
								}),
							),
							wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list!),
							wrappingInputRule(
								/^(\d+)\.\s$/,
								schema.nodes.ordered_list!,
								(match) => ({ order: Number(match[1]) }),
								(match, node) =>
									node.childCount + node.attrs.order === Number(match[1]),
							),
							wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote!),
							textblockTypeInputRule(/^```$/, schema.nodes.code_block!),
						],
					}),
				],
			}),
			attributes: {
				// The editor owns its own typography (see the style block below);
				// vocab-check: ignore-next-line (Tailwind's `.prose` class)
				// it deliberately does not wear the shared `.prose` article styles,
				// whose 175% line-height and large block margins read as a rendered
				// document, not a writing surface.
				class: 'focus:outline-none',
			},
			// `this` is always the live EditorView, including binding-origin
			// transactions dispatched while the Y type hydrates ProseMirror.
			dispatchTransaction(this: EditorView, tr) {
				const newState = this.state.apply(tr);
				this.updateState(newState);
				updateActiveFormats(newState);
				// A note's title is not pushed from here: `openContent` hangs that write
				// on the body's own field signal, coalesced, along with `updatedAt`.
				// There is no preview to push at all any more. The editor only edits.
			},
		});
		configureYProsemirror({ ytype: yxmlfragment })(
			currentView.state,
			currentView.dispatch,
		);

		view = currentView;
		updateActiveFormats(currentView.state);

		/**
		 * Drop the undo history when something outside this editor rewrites the
		 * body underneath it.
		 *
		 * A `Y.UndoManager` tracks the origins it was told about, which here are
		 * this editor's own transactions. Anything else that edits the fragment
		 * (a body sent back from the folder, ADR-0338; a peer's change arriving
		 * over the socket) leaves the stack referencing items that are now
		 * deleted, and the next Cmd-Z either drains the whole stack silently or
		 * re-inserts a block the person deleted minutes ago at the end of the
		 * new text. Neither undoes what just happened, and both look like a bug
		 * in undo.
		 *
		 * Clearing says the honest thing: history is what you typed here, and it
		 * ends where somebody else's edit begins. Making the rewrite itself one
		 * undoable step is the better outcome and needs the store to expose the
		 * origin it writes under, which is a decision about the store's surface
		 * rather than about this component.
		 */
		const document = yxmlfragment.doc;
		const forgetOnForeignEdit = (transaction: Y.Transaction) => {
			if (!transaction.changedParentTypes.has(yxmlfragment)) return;
			if (transaction.origin === undoManager) return;
			if (undoManager.trackedOrigins.has(transaction.origin)) return;
			undoManager.clear();
		};
		document?.on('afterTransaction', forgetOnForeignEdit);

		return () => {
			document?.off('afterTransaction', forgetOnForeignEdit);
			currentView.destroy();
			undoManager.destroy();
			view = undefined;
		};
	});

	$effect(() => {
		if (!view) return;
		focusRequest;
		view.dispatch(
			view.state.tr
				.setSelection(TextSelection.atEnd(view.state.doc))
				.scrollIntoView(),
		);
		view.focus();
	});
</script>

{#snippet toggleButton(pressed: boolean, onToggle: () => void, Icon: typeof BoldIcon, label: string)}
	<Tooltip.Root>
		<Tooltip.Trigger>
			<Toggle size="sm" {pressed} onPressedChange={onToggle}>
				<Icon class="size-4" />
			</Toggle>
		</Tooltip.Trigger>
		<Tooltip.Content>{label}</Tooltip.Content>
	</Tooltip.Root>
{/snippet}

{#snippet groupItem(value: string, Icon: typeof BoldIcon, label: string)}
	<Tooltip.Root>
		<Tooltip.Trigger>
			<ToggleGroup.Item {value}> <Icon class="size-4" /> </ToggleGroup.Item>
		</Tooltip.Trigger>
		<Tooltip.Content>{label}</Tooltip.Content>
	</Tooltip.Root>
{/snippet}

<div class="flex h-full flex-col">
	{#if view}
		<div class="flex items-center gap-1 border-b p-2">
			{@render toggleButton(activeFormats.bold, () => { toggleMark(schema.marks.strong!)(view!.state, view!.dispatch); view!.focus(); }, BoldIcon, 'Bold (⌘B)')}
			{@render toggleButton(activeFormats.italic, () => { toggleMark(schema.marks.em!)(view!.state, view!.dispatch); view!.focus(); }, ItalicIcon, 'Italic (⌘I)')}
			{@render toggleButton(activeFormats.underline, () => { toggleMark(schema.marks.underline!)(view!.state, view!.dispatch); view!.focus(); }, UnderlineIcon, 'Underline (⌘U)')}
			{@render toggleButton(activeFormats.strike, () => { toggleMark(schema.marks.strike!)(view!.state, view!.dispatch); view!.focus(); }, StrikethroughIcon, 'Strikethrough (⌘⇧S)')}

			<Separator orientation="vertical" class="mx-1 h-6" />

			<ToggleGroup.Root
				type="single"
				size="sm"
				value={activeHeading}
				onValueChange={(value) => {
					switch (value) {
						case 'h1':
						case 'h2':
						case 'h3': {
							const level = ({ h1: 1, h2: 2, h3: 3 } satisfies Record<'h1' | 'h2' | 'h3', number>)[value];
							const isActive = nodeActive(view!.state, schema.nodes.heading!, { level });
							if (isActive) {
								setBlockType(schema.nodes.paragraph!)(view!.state, view!.dispatch);
							} else {
								setBlockType(schema.nodes.heading!, { level })(view!.state, view!.dispatch);
							}
							view!.focus();
							break;
						}
					}
				}}
			>
				{@render groupItem('h1', Heading1Icon, 'Heading 1')}
				{@render groupItem('h2', Heading2Icon, 'Heading 2')}
				{@render groupItem('h3', Heading3Icon, 'Heading 3')}
			</ToggleGroup.Root>

			<Separator orientation="vertical" class="mx-1 h-6" />

			<ToggleGroup.Root
				type="single"
				size="sm"
				value={activeListType}
				onValueChange={(value) => {
					if (!view) return;

					switch (value) {
						case 'bullet': {
							if (nodeActive(view.state, schema.nodes.bullet_list!)) {
								liftListItem(schema.nodes.list_item!)(view.state, view.dispatch);
							} else {
								wrapInList(schema.nodes.bullet_list!)(view.state, view.dispatch);
							}
							view.focus();
							break;
						}
						case 'ordered': {
							if (nodeActive(view.state, schema.nodes.ordered_list!)) {
								liftListItem(schema.nodes.list_item!)(view.state, view.dispatch);
							} else {
								wrapInList(schema.nodes.ordered_list!)(view.state, view.dispatch);
							}
							view.focus();
							break;
						}
						case 'task': {
							if (nodeActive(view.state, schema.nodes.taskList!)) {
								liftListItem(schema.nodes.taskItem!)(view.state, view.dispatch);
							} else {
								wrapInList(schema.nodes.taskList!)(view.state, view.dispatch);
							}
							view.focus();
							break;
						}
					}
				}}
			>
				{@render groupItem('bullet', ListIcon, 'Bullet List')}
				{@render groupItem('ordered', ListOrderedIcon, 'Ordered List')}
				{@render groupItem('task', ListChecksIcon, 'Checklist')}
			</ToggleGroup.Root>

			<Separator orientation="vertical" class="mx-1 h-6" />

			{@render toggleButton(activeFormats.blockquote, () => { if (nodeActive(view!.state, schema.nodes.blockquote!)) { lift(view!.state, view!.dispatch); } else { wrapIn(schema.nodes.blockquote!)(view!.state, view!.dispatch); } view!.focus(); }, QuoteIcon, 'Blockquote (⌘⇧B)')}
		</div>
	{/if}
	<div bind:this={element} class="flex-1 overflow-y-auto p-8"></div>
</div>

<style>
	/*
	 * Editor-owned typography. This is a writing surface, not a rendered
	 * article, so it sets its own tight rhythm instead of borrowing the shared
	 * vocab-check: ignore-next-line (Tailwind's `.prose` class)
	 * `.prose` styles. Tokens are the app's oklch theme variables, used directly
	 * (they already carry the color function; do not wrap in `hsl()`).
	 *
	 * The text fills the full pane width (left-anchored, no reading-measure cap):
	 * the writing surface uses the whole resizable pane the way the rest of the
	 * database does, rather than floating a narrow column. Line length is
	 * governed by how wide the user drags the pane.
	 */
	:global(.ProseMirror) {
		min-height: 100%;
		color: var(--foreground);
		font-size: 1rem;
		line-height: 1.6;
	}

	/*
	 * The first block is the note's title (honeycrisp derives the note title
	 * from the first line). Style it here rather than letting a stray article
	 * rule decide what looks like a title.
	 */
	:global(.ProseMirror > :first-child) {
		font-size: 1.75rem;
		font-weight: 700;
		line-height: 1.25;
		margin: 0 0 0.75rem;
	}

	/* Even block rhythm; adjacent vertical margins collapse, so the title's
	   bottom margin and the next block's top margin do not stack. */
	:global(.ProseMirror > * + *) {
		margin-top: 0.6rem;
	}

	:global(.ProseMirror h1:not(:first-child)) {
		font-size: 1.5rem;
		font-weight: 600;
		line-height: 1.3;
		margin-top: 1.4rem;
	}
	:global(.ProseMirror h2:not(:first-child)) {
		font-size: 1.25rem;
		font-weight: 600;
		line-height: 1.3;
		margin-top: 1.2rem;
	}
	:global(.ProseMirror h3:not(:first-child)) {
		font-size: 1.1rem;
		font-weight: 600;
		line-height: 1.3;
		margin-top: 1rem;
	}

	:global(.ProseMirror ul),
	:global(.ProseMirror ol) {
		margin: 0;
		padding-left: 1.4rem;
	}
	:global(.ProseMirror ul) {
		list-style: disc;
	}
	:global(.ProseMirror ol) {
		list-style: decimal;
	}
	:global(.ProseMirror li + li) {
		margin-top: 0.15rem;
	}

	:global(.ProseMirror blockquote) {
		margin: 0;
		border-left: 2px solid var(--border);
		padding-left: 1rem;
		color: var(--muted-foreground);
	}

	:global(.ProseMirror :not(pre) > code) {
		background: var(--muted);
		border-radius: 0.25rem;
		padding: 0.1rem 0.3rem;
		font-size: 0.875em;
	}
	:global(.ProseMirror pre) {
		background: var(--muted);
		border-radius: 0.375rem;
		padding: 0.75rem 1rem;
		overflow-x: auto;
	}
	:global(.ProseMirror pre code) {
		background: none;
		padding: 0;
		font-size: 0.875em;
	}

	/* Placeholder mirrors the title size on an empty note. */
	:global(.ProseMirror p.is-editor-empty:first-child::before) {
		font-size: 1.75rem;
		font-weight: 700;
		line-height: 1.25;
		color: var(--muted-foreground);
		content: attr(data-placeholder);
		float: left;
		height: 0;
		pointer-events: none;
	}

	/* Task lists: a checkbox aligned to the start of its content row. */
	:global(.ProseMirror ul.task-list) {
		list-style: none;
		padding-left: 0;
	}
	:global(.ProseMirror ul.task-list li) {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
	}
	:global(.ProseMirror ul.task-list li > label) {
		margin-top: 0.3rem;
	}
</style>

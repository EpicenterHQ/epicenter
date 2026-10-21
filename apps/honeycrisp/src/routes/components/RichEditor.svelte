<script lang="ts">
	import type { FileEdit } from '@epicenter/folder/edits';
	import { createFileEdit } from '@epicenter/svelte/edits';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import * as Popover from '@epicenter/ui/popover';
	import { Separator } from '@epicenter/ui/separator';
	import { Toggle } from '@epicenter/ui/toggle';
	import BoldIcon from '@lucide/svelte/icons/bold';
	import CodeIcon from '@lucide/svelte/icons/code';
	import Heading1Icon from '@lucide/svelte/icons/heading-1';
	import Heading2Icon from '@lucide/svelte/icons/heading-2';
	import Heading3Icon from '@lucide/svelte/icons/heading-3';
	import ItalicIcon from '@lucide/svelte/icons/italic';
	import LinkIcon from '@lucide/svelte/icons/link';
	import ListIcon from '@lucide/svelte/icons/list';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import ListOrderedIcon from '@lucide/svelte/icons/list-ordered';
	import MinusIcon from '@lucide/svelte/icons/minus';
	import QuoteIcon from '@lucide/svelte/icons/quote';
	import RedoIcon from '@lucide/svelte/icons/redo-2';
	import SquareCodeIcon from '@lucide/svelte/icons/square-code';
	import StrikethroughIcon from '@lucide/svelte/icons/strikethrough';
	import UndoIcon from '@lucide/svelte/icons/undo-2';
	import { setBlockType, toggleMark } from 'prosemirror-commands';
	import { redo, redoDepth, undo, undoDepth } from 'prosemirror-history';
	import type { MarkType } from 'prosemirror-model';
	import { liftListItem, wrapInList } from 'prosemirror-schema-list';
	import { type Command, EditorState, Plugin } from 'prosemirror-state';
	import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
	import 'prosemirror-view/style/prosemirror.css';
	import { untrack } from 'svelte';
	import type { HoneycrispTables } from '$lib/data.js';
	import {
		editingPlugins,
		nodeActive,
		noteBody,
		stateAfter,
		stateShowing,
		toggleQuote,
	} from '$lib/editor/rich-text.js';
	import { bodyCodec } from '$lib/editor/markdown.js';
	import { noteSchema as schema } from '$lib/editor/schema.js';

	let {
		fileEdit,
		focusRequest,
		onOpenSource,
		onRefuse,
	}: {
		/** The note as shown: its draft while an edit is held, else the cache's. */
		fileEdit: FileEdit<HoneycrispTables['notes']>;
		focusRequest: number;
		onOpenSource: () => void;
		/** An edit Markdown cannot spell was not made; says why. */
		onRefuse: (reason: string) => void;
	} = $props();

	/**
	 * The view's state is the one rich-text state: the document, cursor,
	 * pending formatting, and undo history. The view lives from the moment the
	 * body is editable as rich text until it stops being so, and no edit in
	 * between recreates it.
	 */
	let view = $state.raw<EditorView>();
	let element = $state<HTMLDivElement>();

	/**
	 * The body shown now. A change elsewhere in the note, such as its title,
	 * or a save landing, gives the same string, so nothing below runs
	 * again.
	 */
	// The parent keys this editor by its file path.
	// svelte-ignore state_referenced_locally
	const trackedEdit = createFileEdit(fileEdit);
	const body = $derived(noteBody(trackedEdit.markdown));
	/** The body as a document, or why it cannot be one. */
	const rich = $derived(body === undefined ? undefined : bodyCodec.decode(body));
	/**
	 * A boolean, on purpose: the view's lifetime depends on this and nothing
	 * else, and a boolean only notifies when it flips. Typing never flips it.
	 */
	const editable = $derived(rich?.supported === true);

	let active = $state.raw({
		bold: false,
		italic: false,
		strike: false,
		code: false,
		link: false,
		heading: 0,
		list: '' as '' | 'bullet' | 'ordered' | 'task',
		quote: false,
		codeBlock: false,
		canUndo: false,
		canRedo: false,
	});
	let linkOpen = $state(false);
	let linkHref = $state('');

	function markActive(state: EditorState, type: MarkType): boolean {
		const { from, $from: start, to, empty } = state.selection;
		if (empty) return !!type.isInSet(state.storedMarks || start.marks());
		return state.doc.rangeHasMark(from, to, type);
	}

	function readActive(state: EditorState) {
		active = {
			bold: markActive(state, schema.marks.strong),
			italic: markActive(state, schema.marks.em),
			strike: markActive(state, schema.marks.strike),
			code: markActive(state, schema.marks.code),
			link: markActive(state, schema.marks.link),
			heading: [1, 2, 3].find((level) => nodeActive(state, schema.nodes.heading, { level })) ?? 0,
			list: nodeActive(state, schema.nodes.taskList)
				? 'task'
				: nodeActive(state, schema.nodes.bullet_list)
					? 'bullet'
					: nodeActive(state, schema.nodes.ordered_list)
						? 'ordered'
						: '',
			quote: nodeActive(state, schema.nodes.blockquote),
			codeBlock: nodeActive(state, schema.nodes.code_block),
			canUndo: undoDepth(state) > 0,
			canRedo: redoDepth(state) > 0,
		};
	}

	const placeholder = new Plugin({
		props: {
			decorations(state) {
				const { doc } = state;
				if (doc.childCount === 1 && doc.firstChild?.isTextblock && doc.firstChild.content.size === 0)
					return DecorationSet.create(doc, [
						Decoration.node(0, doc.firstChild.nodeSize, {
							class: 'is-editor-empty',
							'data-placeholder': 'Start writing…',
						}),
					]);
				return DecorationSet.empty;
			},
		},
	});

	const taskCheckbox = new Plugin({
		props: {
			handleClickOn(view, _pos, node, nodePos, event) {
				if (node.type !== schema.nodes.taskItem) return false;
				const target = event.target;
				if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return false;
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

	function show(shown: EditorView, state: EditorState) {
		shown.updateState(state);
		readActive(state);
	}

	// Mount once per editable stretch. `editable` and `element` are the only
	// things read here, so an edit does not come back through this effect.
	$effect(() => {
		if (!element || !editable) return;
		const opened = untrack(() => rich);
		if (!opened?.supported) return;
		/** Cleared with this view: a transaction it is handed afterwards changes nothing. */
		let alive = true;
		// Untracked: the view asks `editable` while it is built, and `locked`
		// changes with every delete and with closing, which must not recreate the view.
		const mountOn = element;
		const created = untrack(() => new EditorView(mountOn, {
			state: EditorState.create({
				doc: opened.doc,
				plugins: [...editingPlugins(), placeholder, taskCheckbox],
			}),
			attributes: { class: 'focus:outline-none', 'aria-label': 'Note text' },
			editable: () => !trackedEdit.locked,
			dispatchTransaction(this: EditorView, transaction) {
				// Something that kept this view, a command or a timer, can still
				// dispatch after it was destroyed. Its document is not the note's.
				if (!alive || this.isDestroyed) return;
				// A refused or stale transaction changes nothing on screen; a
				// taken one is already in the note's draft, and its save started.
				const next = stateAfter(this.state, transaction, fileEdit, onRefuse);
				if (next !== undefined) show(this, next);
			},
		}));
		view = created;
		readActive(created.state);
		return () => {
			alive = false;
			created.destroy();
			view = undefined;
		};
	});

	// Follow the body shown. A body this view wrote, a save landing, or the
	// same content respelled keeps the state; different content (Source, a
	// version, or an explicitly accepted saved source) replaces it with a new
	// history. While an edit is held the body is
	// the draft's, which a read never changes, so this never replaces typing in
	// flight.
	$effect(() => {
		const current = rich;
		const mounted = untrack(() => view);
		if (!mounted || !current?.supported) return;
		const next = stateShowing(mounted.state, current.doc);
		if (next !== mounted.state) show(mounted, next);
	});

	// The view asks `editable` only when it updates: ask it again when the note
	// starts or stops taking edits, so the text is not editable while locked.
	$effect(() => {
		trackedEdit.locked;
		untrack(() => view)?.setProps({});
	});

	$effect(() => {
		focusRequest;
		untrack(() => view)?.focus();
	});

	function run(command: Command) {
		if (!view) return;
		command(view.state, view.dispatch);
		view.focus();
	}

	function toggleHeading(level: number) {
		run(
			active.heading === level
				? setBlockType(schema.nodes.paragraph)
				: setBlockType(schema.nodes.heading, { level }),
		);
	}

	function toggleList(kind: 'bullet' | 'ordered' | 'task') {
		const list = { bullet: schema.nodes.bullet_list, ordered: schema.nodes.ordered_list, task: schema.nodes.taskList }[kind];
		const item = kind === 'task' ? schema.nodes.taskItem : schema.nodes.list_item;
		if (active.list === kind) run(liftListItem(item));
		else if (active.list === '') run(wrapInList(list));
		else {
			// Leave the other kind of list first, then wrap in this one.
			run(liftListItem(active.list === 'task' ? schema.nodes.taskItem : schema.nodes.list_item));
			run(wrapInList(list));
		}
	}

	function openLink() {
		if (!view) return;
		const existing = schema.marks.link.isInSet(view.state.selection.$from.marks());
		linkHref = existing ? String(existing.attrs.href) : '';
		linkOpen = true;
	}

	function applyLink() {
		if (!view) return;
		const href = linkHref.trim();
		linkOpen = false;
		const { from, to, empty } = view.state.selection;
		if (href === '') {
			run((state, dispatch) => {
				dispatch?.(state.tr.removeMark(from, to, schema.marks.link));
				return true;
			});
			return;
		}
		const mark = schema.marks.link.create({ href });
		run((state, dispatch) => {
			dispatch?.(
				empty
					? state.tr.insert(from, schema.text(href, [mark]))
					: state.tr.removeMark(from, to, schema.marks.link).addMark(from, to, mark),
			);
			return true;
		});
	}
</script>

{#snippet toggle(pressed: boolean, onToggle: () => void, Icon: typeof BoldIcon, label: string)}
	<Toggle size="sm" {pressed} aria-label={label} title={label} onPressedChange={onToggle}>
		<Icon class="size-4" />
	</Toggle>
{/snippet}

{#if editable}
	<div class="flex h-full min-h-0 flex-col">
		<div class="flex flex-wrap items-center gap-1 border-b px-2 py-1.5" role="toolbar" aria-label="Formatting">
			<Button variant="ghost" size="icon-sm" aria-label="Undo" title="Undo (⌘Z)" disabled={!active.canUndo} onclick={() => run(undo)}>
				<UndoIcon />
			</Button>
			<Button variant="ghost" size="icon-sm" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!active.canRedo} onclick={() => run(redo)}>
				<RedoIcon />
			</Button>
			<Separator orientation="vertical" class="mx-1 h-6" />
			{@render toggle(active.bold, () => run(toggleMark(schema.marks.strong)), BoldIcon, 'Bold')}
			{@render toggle(active.italic, () => run(toggleMark(schema.marks.em)), ItalicIcon, 'Italic')}
			{@render toggle(active.strike, () => run(toggleMark(schema.marks.strike)), StrikethroughIcon, 'Strikethrough')}
			{@render toggle(active.code, () => run(toggleMark(schema.marks.code)), CodeIcon, 'Inline code')}
			<Popover.Root bind:open={linkOpen}>
				<Popover.Trigger>
					{#snippet child({ props })}
						<Toggle {...props} size="sm" pressed={active.link} aria-label="Link" title="Link" onPressedChange={openLink}>
							<LinkIcon class="size-4" />
						</Toggle>
					{/snippet}
				</Popover.Trigger>
				<Popover.Content class="w-80 p-2" align="start">
					<form
						class="flex items-center gap-2"
						onsubmit={(event) => {
							event.preventDefault();
							applyLink();
						}}
					>
						<Input class="h-8" placeholder="https://example.com" aria-label="Link address" bind:value={linkHref} />
						<!-- The popover is outside the app's inert root. -->
						<Button type="submit" size="sm" disabled={trackedEdit.locked}>{linkHref.trim() === '' ? 'Remove' : 'Apply'}</Button>
					</form>
				</Popover.Content>
			</Popover.Root>
			<Separator orientation="vertical" class="mx-1 h-6" />
			{@render toggle(active.heading === 1, () => toggleHeading(1), Heading1Icon, 'Heading 1')}
			{@render toggle(active.heading === 2, () => toggleHeading(2), Heading2Icon, 'Heading 2')}
			{@render toggle(active.heading === 3, () => toggleHeading(3), Heading3Icon, 'Heading 3')}
			<Separator orientation="vertical" class="mx-1 h-6" />
			{@render toggle(active.list === 'bullet', () => toggleList('bullet'), ListIcon, 'Bullet list')}
			{@render toggle(active.list === 'ordered', () => toggleList('ordered'), ListOrderedIcon, 'Numbered list')}
			{@render toggle(active.list === 'task', () => toggleList('task'), ListChecksIcon, 'Task list')}
			<Separator orientation="vertical" class="mx-1 h-6" />
			{@render toggle(active.quote, () => run(toggleQuote), QuoteIcon, 'Quote')}
			{@render toggle(
				active.codeBlock,
				() => run(active.codeBlock ? setBlockType(schema.nodes.paragraph) : setBlockType(schema.nodes.code_block)),
				SquareCodeIcon,
				'Code block',
			)}
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="Divider"
				title="Divider"
				onclick={() =>
					run((state, dispatch) => {
						dispatch?.(state.tr.replaceSelectionWith(schema.nodes.horizontal_rule.create()).scrollIntoView());
						return true;
					})}
			>
				<MinusIcon />
			</Button>
		</div>
		<div bind:this={element} class="honeycrisp-editor min-h-0 flex-1 overflow-y-auto p-6"></div>
	</div>
{:else}
	<div class="flex h-full flex-col items-start gap-3 overflow-y-auto p-6 text-sm" role="status">
		<p class="font-medium">This note opens in Source only</p>
		<p class="text-muted-foreground">
			The rich-text editor would change or drop part of it when it writes, so it is not opened here. Nothing
			in the file was changed.
		</p>
		<ul class="list-disc space-y-0.5 ps-5 text-muted-foreground">
			{#each rich === undefined || rich.supported ? [] : rich.reasons as reason (reason)}
				<li>{reason}</li>
			{/each}
		</ul>
		<Button size="sm" onclick={onOpenSource}>Continue in Source</Button>
	</div>
{/if}

<style>
	/* The editor owns its typography: a writing surface, not a rendered article. */
	:global(.honeycrisp-editor .ProseMirror) {
		min-height: 100%;
		color: var(--foreground);
		font-size: 1rem;
		line-height: 1.6;
	}
	:global(.honeycrisp-editor .ProseMirror > * + *) {
		margin-top: 0.6rem;
	}
	:global(.honeycrisp-editor .ProseMirror h1) {
		font-size: 1.6rem;
		font-weight: 700;
		line-height: 1.25;
	}
	:global(.honeycrisp-editor .ProseMirror h2) {
		font-size: 1.3rem;
		font-weight: 600;
		line-height: 1.3;
	}
	:global(.honeycrisp-editor .ProseMirror h3) {
		font-size: 1.1rem;
		font-weight: 600;
		line-height: 1.3;
	}
	:global(.honeycrisp-editor .ProseMirror ul),
	:global(.honeycrisp-editor .ProseMirror ol) {
		margin: 0;
		padding-left: 1.4rem;
	}
	:global(.honeycrisp-editor .ProseMirror ul) {
		list-style: disc;
	}
	:global(.honeycrisp-editor .ProseMirror ol) {
		list-style: decimal;
	}
	:global(.honeycrisp-editor .ProseMirror li + li) {
		margin-top: 0.15rem;
	}
	:global(.honeycrisp-editor .ProseMirror blockquote) {
		margin: 0;
		border-left: 2px solid var(--border);
		padding-left: 1rem;
		color: var(--muted-foreground);
	}
	:global(.honeycrisp-editor .ProseMirror a) {
		color: var(--primary);
		text-decoration: underline;
	}
	:global(.honeycrisp-editor .ProseMirror hr) {
		border: 0;
		border-top: 1px solid var(--border);
		margin: 1rem 0;
	}
	:global(.honeycrisp-editor .ProseMirror :not(pre) > code) {
		background: var(--muted);
		border-radius: 0.25rem;
		padding: 0.1rem 0.3rem;
		font-size: 0.875em;
	}
	:global(.honeycrisp-editor .ProseMirror pre) {
		background: var(--muted);
		border-radius: 0.375rem;
		padding: 0.75rem 1rem;
		overflow-x: auto;
	}
	:global(.honeycrisp-editor .ProseMirror pre code) {
		background: none;
		padding: 0;
		font-size: 0.875em;
	}
	:global(.honeycrisp-editor .ProseMirror p.is-editor-empty:first-child::before) {
		color: var(--muted-foreground);
		content: attr(data-placeholder);
		float: left;
		height: 0;
		pointer-events: none;
	}
	:global(.honeycrisp-editor .ProseMirror ul.task-list) {
		list-style: none;
		padding-left: 0;
	}
	:global(.honeycrisp-editor .ProseMirror ul.task-list li) {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
	}
	:global(.honeycrisp-editor .ProseMirror ul.task-list li > label) {
		margin-top: 0.3rem;
	}
</style>

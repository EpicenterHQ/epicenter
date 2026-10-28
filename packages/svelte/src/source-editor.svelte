<!--
	A repository file's whole text, frontmatter included, in CodeMirror, with
	a status line that says as you type whether the frontmatter parses and,
	given a note name, whether the note matches its schema. It saves through
	`repo.files` as you type, except a text that would break frontmatter that
	parses, which it holds until it parses again; a file that does not parse
	saves every step of its repair.

	It holds the file open for as long as it is mounted; key it by the path.

	```svelte
	{#key path}
		<SourceEditor {repo} {path} lens="notes" />
	{/key}
	```
-->
<script lang="ts" generics="TDefs extends Definitions">
	import type { Definitions, NoteName, OpenFile, Repository, TextStatus } from '@epicenter/repository';
	import { Badge } from '@epicenter/ui/badge';
	import { onMount, untrack } from 'svelte';
	import { createSourceEditor, type SourceEditor } from './codemirror.js';

	let {
		repo,
		path,
		lens,
		label = 'File source',
		focusRequest = 0,
		class: className = '',
	}: {
		repo: Repository<TDefs>;
		/** Fixed for this editor's life. */
		path: string;
		/** The note name whose schema the status checks; without one, it checks only that the frontmatter parses. */
		lens?: NoteName<TDefs>;
		/** The editor's accessible name. */
		label?: string;
		/** Bumped to move focus into the editor. */
		focusRequest?: number;
		class?: string;
	} = $props();

	let element: HTMLDivElement;
	let editor = $state.raw<SourceEditor>();
	let status = $state.raw<TextStatus>();
	/** Whether the text shown is held back, since saving it would break frontmatter that parses. */
	let held = $state(false);
	/** Why the last save failed, until one succeeds. */
	let failure = $state<string>();

	onMount(() => {
		const { files } = untrack(() => repo);
		const name = untrack(() => lens);
		let destroyed = false;
		let file: OpenFile | undefined;
		let created: SourceEditor | undefined;
		void files.open(untrack(() => path)).then((opened) => {
			if (destroyed) return opened.close();
			file = opened;
			created = createSourceEditor({
				parent: element,
				file: opened,
				parses: (text) => files.status(text).parses,
				onText(text, isHeld) {
					status = files.status(text, name);
					held = isHeld;
				},
				onSave(saved) {
					void saved.then(({ error }) => {
						failure = error === null || error.name === 'Closed' ? undefined : error.message;
					});
				},
				label: untrack(() => label),
			});
			editor = created;
		});
		return () => {
			destroyed = true;
			created?.destroy();
			file?.close();
		};
	});

	// Each request focuses the editor once it exists.
	$effect(() => {
		const target = editor;
		if (focusRequest > 0) target?.focus();
	});
</script>

<div class={['source-editor flex min-h-0 flex-col', className]}>
	<div bind:this={element} class="min-h-0 flex-1 overflow-y-auto"></div>
	{#if status !== undefined}
		<div class="shrink-0 space-y-1 border-t px-3 py-2 text-xs" role="status" data-testid="source-status">
			{#if !status.parses}
				<p class="flex flex-wrap items-center gap-2">
					<Badge variant="destructive">Frontmatter doesn't parse (line {status.line})</Badge>
					<span class="text-muted-foreground">{status.message}</span>
				</p>
				{#if held}
					<p class="text-muted-foreground">Not saved until it parses again; the file keeps its last saved text.</p>
				{/if}
			{:else if status.matches === false}
				<p class="flex flex-wrap items-center gap-2">
					<Badge variant="destructive">Doesn't match the schema</Badge>
				</p>
				<ul class="space-y-0.5 text-muted-foreground">
					{#each status.issues as issue}
						<li>{issue}</li>
					{/each}
				</ul>
			{:else}
				<p class="flex items-center gap-2">
					<Badge variant="secondary">{status.matches ? 'Matches the schema' : 'Frontmatter parses'}</Badge>
				</p>
			{/if}
			{#if failure !== undefined}
				<p class="text-destructive">Not saved: {failure}</p>
			{/if}
		</div>
	{/if}
</div>

<style>
	.source-editor :global(.cm-editor) {
		height: 100%;
		font-size: 0.85rem;
	}
	.source-editor :global(.cm-editor.cm-focused) {
		outline: none;
	}
	.source-editor :global(.cm-content) {
		padding: 0.75rem 0;
		font-family: var(--font-mono, ui-monospace, monospace);
	}
</style>

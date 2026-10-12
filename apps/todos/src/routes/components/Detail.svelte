<!--
	The detail pane: what the app shows now. A todo from the list is its fields
	and notes; a file from Files, or a todo whose text does not read as a
	todo, is its text. Each view is keyed by what it shows, so another file
	mounts a new view.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { rowStemOf } from '@epicenter/folder';
	import { getTodos } from '$lib/todos.svelte.js';
	import FileView from './FileView.svelte';
	import TodoDetail from './TodoDetail.svelte';

	const todos = getTodos();

	let { onBack }: { onBack?: () => void } = $props();

	const shown = $derived(todos.selected);
	const stem = $derived(
		shown?.as === 'todos' ? rowStemOf(todos.folder.tables.todos.name, shown.path) : undefined,
	);
</script>

{#if shown === undefined}
	<Empty.Root class="h-full">
		<Empty.Title>Select a todo to edit it</Empty.Title>
		<Empty.Description>Files opens any file, a todo's Markdown included, as text.</Empty.Description>
		{#if onBack}
			<Button variant="outline" size="sm" onclick={onBack}><ArrowLeftIcon /> Back to todos</Button>
		{/if}
	</Empty.Root>
{:else if stem !== undefined}
	{#key shown.path}
		<TodoDetail {stem} {onBack} />
	{/key}
{:else}
	{#key `${shown.as}:${shown.path}`}
		<FileView path={shown.path} {onBack} />
	{/key}
{/if}

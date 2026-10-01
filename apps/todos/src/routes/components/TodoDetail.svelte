<script lang="ts">
	import { readSource } from '@epicenter/app/files';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Input } from '@epicenter/ui/input';
	import * as Tabs from '@epicenter/ui/tabs';
	import { Textarea } from '@epicenter/ui/textarea';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { patchTodo, stemOf, type TodoEditor, type TodoEntry } from '$lib/editor.svelte.js';
	import { withFileNewlines } from '$lib/files.js';
	import type { Todos } from '$lib/todos.svelte.js';
	import { confirmDelete } from './file-actions.js';
	import FileNameBar from './FileNameBar.svelte';
	import SaveStatus from './SaveStatus.svelte';

	let {
		todos,
		editor,
		entry,
		onBack,
	}: {
		todos: Todos;
		editor: TodoEditor;
		/** The listed row, or undefined when the file left the folder. */
		entry: TodoEntry | undefined;
		/** Shown on narrow screens, where the list and the editor take turns. */
		onBack?: () => void;
	} = $props();

	/** The buffer's interpretation, for the structured controls. */
	const parsed = $derived(readSource(editor.buffer));
	const title = $derived(typeof parsed.values?.title === 'string' ? parsed.values.title : '');
	const done = $derived(parsed.values?.done === true);
	const fieldsEditable = $derived(parsed.values !== undefined && parsed.body !== undefined);
	let tab = $state('notes');
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Todo">
	<div class="flex items-center gap-2 border-b px-3 py-3 sm:px-4">
		{#if onBack}
			<Button variant="ghost" size="icon-sm" aria-label="Back to todos" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
				<ArrowLeftIcon />
			</Button>
		{/if}
		<Checkbox
			checked={done}
			disabled={!fieldsEditable}
			aria-label="Done"
			onCheckedChange={(checked) => patchTodo(editor, { fields: { done: checked === true } })}
		/>
		<Input
			class="flex-1 text-base font-medium"
			value={title}
			placeholder="Title"
			aria-label="Title"
			disabled={!fieldsEditable}
			oninput={(event) => patchTodo(editor, { fields: { title: event.currentTarget.value } })}
		/>
	</div>

	<SaveStatus {editor} onDiscardRemoved={() => todos.discardRemoved(editor.path)} />

	{#if entry?.issues || parsed.issues.length > 0}
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs">
			<p class="mb-1 flex items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				Edit the source to fix it; the file stays saved as written.
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each entry?.issues ?? [] as issue, index (index)}
					<li>{issue.kind === 'field' ? `${issue.field}: ` : ''}{issue.message}</li>
				{/each}
				{#if !entry?.issues}
					{#each parsed.issues as issue, index (index)}
						<li>Unsaved source: {issue.message}</li>
					{/each}
				{/if}
			</ul>
		</div>
	{/if}

	<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-4">
		<Tabs.List>
			<Tabs.Trigger value="notes">Notes</Tabs.Trigger>
			<Tabs.Trigger value="source">Source</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="notes" class="min-h-0 flex-1">
			<Textarea
				class="h-full min-h-40 resize-none font-sans"
				value={parsed.body ?? ''}
				placeholder="Notes in Markdown"
				aria-label="Notes"
				disabled={parsed.body === undefined}
				oninput={(event) =>
					patchTodo(editor, { body: withFileNewlines(event.currentTarget.value, parsed.body ?? '') })}
			/>
		</Tabs.Content>
		<Tabs.Content value="source" class="min-h-0 flex-1">
			<Textarea
				class="h-full min-h-40 resize-none font-mono text-xs"
				value={editor.buffer}
				aria-label="Markdown source"
				spellcheck={false}
				oninput={(event) => editor.input(withFileNewlines(event.currentTarget.value, editor.buffer))}
			/>
		</Tabs.Content>
	</Tabs.Root>

	<FileNameBar
		prefix="todos/"
		name={stemOf(editor.path)}
		suffix=".md"
		onRename={(stem) => todos.rename(editor.path, `${stem}.md`)}
		onDelete={() => void confirmDelete(todos, editor.path)}
	/>
</section>

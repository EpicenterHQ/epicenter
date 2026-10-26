<script lang="ts">
	import { draft } from '@epicenter/svelte/folder';
	import RowIssues from '@epicenter/svelte/row-issues';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Textarea } from '@epicenter/ui/textarea';
	import { toast } from '@epicenter/ui/sonner';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { getFolder } from '$lib/folder.js';
	import { labelOf, todoPath } from '$lib/local-todos.js';

	const folder = getFolder();
	let {
		id: shownId,
		onBack,
		onDeleted,
	}: {
		id: string;
		onBack?: () => void;
		onDeleted?: () => void;
	} = $props();

	// The parent keys this view by the todo.
	// svelte-ignore state_referenced_locally
	const id = shownId;
	const path = todoPath(id);
	const row = $derived(folder.tables.todos.row(id));
	const todo = $derived(row?.issues === null ? row : undefined);
	const title = draft(
		() => todo?.fields.title ?? '',
		(text) => folder.tables.todos.update(id, { fields: { title: text } }),
	);
	const body = draft(
		() => todo?.body ?? '',
		(text) => folder.tables.todos.update(id, { body: text }),
	);
	async function toggleDone() {
		if (todo === undefined) return;
		const { error } = await folder.tables.todos.update(id, {
			fields: { done: !todo.fields.done },
		});
		if (error !== null)
			toast.error('Could not update todo', { description: error.message });
	}
	const source = $derived(folder.file(path)?.data);
	const unreadable = $derived(
		row?.issues?.some((issue) => issue.kind === 'unreadable') ?? false,
	);

	function confirmDelete(label: string) {
		confirmationDialog.open({
			title: `Delete “${label}”?`,
			description: `This deletes ${path} from this device. Other files stay in the folder.`,
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				const { error } = await folder.delete(path);
				if (error !== null) {
					toast.error('Could not delete todo', { description: error.message });
					return;
				}
				onDeleted?.();
			},
		});
	}
</script>

{#snippet back()}
	{#if onBack}
		<Button variant="ghost" size="icon-sm" aria-label="Back to todos" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
			<ArrowLeftIcon />
		</Button>
	{/if}
{/snippet}

{#snippet fileBar(label: string)}
	<div class="flex shrink-0 items-center gap-2 border-t px-4 py-2">
		<span class="min-w-0 truncate font-mono text-xs text-muted-foreground" data-testid="file-path">{path}</span>
		<Button class="ml-auto" size="sm" variant="ghost-destructive" onclick={() => confirmDelete(label)}>Delete</Button>
	</div>
{/snippet}

<section class="flex h-full min-h-0 flex-col overflow-y-auto" aria-label="Todo">
	{#if title.error !== null || body.error !== null}
		<div class="space-y-2 px-4 py-2">
			<UnsavedEdit draft={title} />
			<UnsavedEdit draft={body} />
		</div>
	{/if}
	{#if todo}
		<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
			{@render back()}
			<Checkbox
				aria-label="Done"
				bind:checked={() => todo.fields.done, () => void toggleDone()}
			/>
			<div class="min-w-0 flex-1 space-y-2">
				<Input
					class="text-base font-medium"
					placeholder="Title"
					aria-label="Title"
					bind:value={title.value}
				/>
			</div>
		</div>
		<div class="flex min-h-48 flex-1 flex-col px-3 py-3 sm:px-4">
			<Textarea
				class="min-h-0 flex-1 field-sizing-fixed resize-none"
				placeholder="Notes in Markdown"
				aria-label="Notes"
				bind:value={body.value}
			/>
		</div>
		{@render fileBar(labelOf(todo))}
	{:else if row}
		<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
			{@render back()}
			<h2 class="min-w-0 flex-1 truncate font-mono text-sm">{path}</h2>
		</div>
		<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="needs-repair">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				{unreadable ? 'Could not read this file.' : 'This file does not read as a todo. Todos keeps its source as it is.'}
			</p>
			<div class="space-y-0.5 text-muted-foreground"><RowIssues issues={row.issues ?? []} /></div>
			{#if unreadable}
				<Button variant="outline" size="sm" onclick={() => void folder.refresh()}>Try again</Button>
			{/if}
		</div>
		{#if typeof source === 'string'}
			<pre class="min-h-48 flex-1 overflow-auto px-4 py-3 font-mono text-xs break-words whitespace-pre-wrap" aria-label="Text of {path}">{source}</pre>
		{/if}
		{@render fileBar(`${id}.md`)}
	{:else}
		<Empty.Root class="flex-1">
			<Empty.Title>This todo is no longer here</Empty.Title>
			<Empty.Description>It was deleted, here or in another tab.</Empty.Description>
			{#if onBack}
				<Button variant="outline" size="sm" onclick={onBack}><ArrowLeftIcon /> Back to todos</Button>
			{/if}
		</Empty.Root>
	{/if}
</section>

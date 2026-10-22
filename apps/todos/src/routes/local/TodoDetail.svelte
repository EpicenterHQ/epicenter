<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import { toast, toastOnError } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { reactiveDocument } from '@epicenter/svelte/document';
	import { getFolder } from '$lib/folder.js';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { describeFailure, labelOf, todoPath } from '$lib/local-todos.js';

	const { folder } = getFolder();

	let {
		id: shownId,
		onBack,
		onDeleted,
	}: {
		/** The todo shown. The parent keys this view by it. */
		id: string;
		/** Shown on narrow screens, where the list and the editor take turns. */
		onBack?: () => void;
		/** The todo was deleted. */
		onDeleted?: () => void;
	} = $props();

	// The parent keys this view by the todo. While the parent replaces it,
	// the prop already reads the next todo, so this view keeps its own.
	// svelte-ignore state_referenced_locally
	const id = shownId;
	const path = todoPath(id);
	/** The todo as stored, with what is typed over it; the folder keeps both after this view. */
	const fileEdit = reactiveDocument(folder.tables.todos.document(id));
	const todo = $derived(fileEdit.content?.issues === null ? fileEdit.content : undefined);


	function confirmDiscard() {
		confirmationDialog.open({
			title: 'Discard unsaved changes?',
			description: `Copy any changes you need from ${path} before discarding them. Saved source remains on this device.`,
			confirm: { text: 'Discard changes', variant: 'destructive' },
			onConfirm: () => { fileEdit.discard(); },
		});
	}

	/** Delete the path after any publication already admitted. */
	async function confirmDelete(label: string) {

		confirmationDialog.open({
			title: `Delete “${label}”?`,
			description: `This deletes ${path} from this device. Other files stay in the folder.`,
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				const { error } = await folder.files.delete(path);
				if (error !== null) toast.error(`Could not delete ${path}`, { description: describeFailure(error) });
				else onDeleted?.();
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
		<Button class="ml-auto" size="sm" variant="ghost-destructive" onclick={() => void confirmDelete(label)}>Delete</Button>
	</div>
{/snippet}

<section class="flex h-full min-h-0 flex-col overflow-y-auto" aria-label="Todo">
	{#if fileEdit.loadError && fileEdit.content}
		<div class="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive" role="status">
			Could not read the latest todo: {fileEdit.loadError.message}.
			<Button variant="link" size="xs" onclick={() => void fileEdit.refresh()}>Try again</Button>
		</div>
	{/if}

	{#if todo}
		{@const shown = todo}
		<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
			{@render back()}
			<Checkbox
				aria-label="Done"

				bind:checked={
					() => shown.fields.done,
					(done) => {
						const changed = toastOnError(fileEdit.patch({ fields: { done } }), 'That change was not made');
						if (changed.error === null) void fileEdit.save();
					}
				}
			/>
			<Input
				class="flex-1 text-base font-medium"
				placeholder="Title"
				aria-label="Title"

				bind:value={() => shown.fields.title, (title) => toastOnError(fileEdit.patch({ fields: { title } }), 'That change was not made')}
			/>
		</div>

		<p class="shrink-0 border-b px-4 py-1 text-xs text-muted-foreground" role="status" data-testid="write-status">
			{#if fileEdit.saveError}
				Not saved: {describeFailure(fileEdit.saveError)}
				<Button variant="link" size="xs" class="h-auto p-0" onclick={() => void fileEdit.save()}>Try again</Button>
				<Button variant="link" size="xs" class="h-auto p-0" onclick={confirmDiscard}>Discard changes</Button>
			{:else if fileEdit.isDirty || fileEdit.isSaving}
				Saving…
			{:else}
				Saved on this device
			{/if}
		</p>

		<div class="flex min-h-48 flex-1 flex-col px-3 py-3 sm:px-4">
			<Textarea
				class="min-h-0 flex-1 field-sizing-fixed resize-none"
				placeholder="Notes in Markdown"
				aria-label="Notes"

					bind:value={() => shown.body, (body) => toastOnError(fileEdit.patch({ body }), 'That change was not made')}
			/>
		</div>

		{@render fileBar(labelOf({ id, fields: shown.fields }))}
	{:else if fileEdit.content}
		{@const broken = fileEdit.content}
		<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
			{@render back()}
			<h2 class="min-w-0 flex-1 truncate font-mono text-sm">{path}</h2>
		</div>
		<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="needs-repair">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				{broken.issues?.some((issue) => issue.kind === 'not-text')
					? 'This file is not text. Todos leaves its bytes untouched.'
					: 'This file does not read as a todo. Todos keeps its text as it is.'}
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each broken.issues ?? [] as issue, index (index)}
					<li>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>
				{/each}
			</ul>
		</div>
		<pre
			class="min-h-48 flex-1 overflow-auto px-4 py-3 font-mono text-xs break-words whitespace-pre-wrap"
			aria-label="Text of {path}">{broken.text}</pre>
		{@render fileBar(`${id}.md`)}
	{:else if fileEdit.loadError && fileEdit.loadError.name !== 'Missing'}
		<Empty.Root class="flex-1">
			<Empty.Title>Could not read this todo</Empty.Title>
			<Empty.Description>{fileEdit.loadError.message}</Empty.Description>
			<Button variant="outline" size="sm" onclick={() => void fileEdit.refresh()}>Try again</Button>
		</Empty.Root>
	{:else if !fileEdit.loadError}
		<Loading class="flex-1" label="Opening the todo…" />
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

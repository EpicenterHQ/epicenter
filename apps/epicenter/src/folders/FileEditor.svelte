<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createFileEdit } from '@epicenter/svelte/edits';
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import { getFolder } from './context.js';

	/** Exact source stays with the folder, including after this view unmounts. */
	let { path: shownPath }: { path: string } = $props();
	const { folder } = getFolder();
	// The parent keys this view by path.
	// svelte-ignore state_referenced_locally
	const path = shownPath;
	const fileEdit = createFileEdit(folder.files.edit(path));
	let inputProblem = $state<string>();
	/** A textarea would rewrite mixed line endings or lone carriage returns. */
	function hasMixedNewlines(text: string) {
		const other = text.replaceAll('\r\n', '');
		return other.includes('\r') || (text.includes('\r\n') && other.includes('\n'));
	}
</script>

<section class="flex min-h-0 flex-1 flex-col" aria-label={path}>
	<header class="flex items-center gap-3 border-b px-4 py-2">
		<h3 class="min-w-0 flex-1 truncate font-mono text-sm">{path}</h3>
		<span class="text-xs text-muted-foreground" role="status">
			{#if fileEdit.saveError}Not saved
			{:else if fileEdit.isDirty || fileEdit.isSaving}Saving…
			{:else if fileEdit.content}Saved when you pause or leave the box.{/if}
		</span>
	</header>
	{#if inputProblem}<p role="alert" class="px-4 py-2 text-sm text-destructive">{inputProblem}</p>{/if}
	{#if fileEdit.saveError}
		<Alert.Root variant="destructive" class="rounded-none border-x-0 border-t-0">
			<Alert.Description>
				<p>Your edit was not saved: {fileEdit.saveError.message}</p>
				<div class="mt-1 flex gap-2">
					<Button size="xs" variant="outline" onclick={() => void fileEdit.save()}>Try again</Button>
					<Button size="xs" variant="ghost" onclick={() => fileEdit.discard()}>Discard edit</Button>
				</div>
			</Alert.Description>
		</Alert.Root>
	{/if}
	{#if fileEdit.loadError}
		<div class="p-4">
			<Alert.Root variant="destructive">
				<Alert.Description>
					{fileEdit.loadError.message}
					<Button size="xs" variant="outline" onclick={() => void fileEdit.refresh()}>Try reading again</Button>
				</Alert.Description>
			</Alert.Root>
		</div>
	{/if}
	{#if fileEdit.content}
		{@const content = fileEdit.content}
		{#if hasMixedNewlines(content.text)}
			<div class="flex min-h-0 flex-1 flex-col gap-2 p-4">
				<p class="text-sm text-muted-foreground">This file mixes line endings, which editing here would change, so it is shown as it is and not edited.</p>
				<pre class="min-h-0 flex-1 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap">{content.text}</pre>
			</div>
		{:else}
			<Textarea
				class="min-h-0 w-full flex-1 resize-none bg-transparent p-4 font-mono text-sm outline-none"
				aria-label="Text of {path}"
				spellcheck="false"
				bind:value={() => content.text.replaceAll('\r\n', '\n'), (value) => {
					const { error } = fileEdit.replaceText(withFileNewlines(value, content.text));
					inputProblem = error?.message;
				}}
			/>
		{/if}
	{:else if !fileEdit.loadError}
		<p class="p-4 text-sm text-muted-foreground">Reading…</p>
	{/if}
</section>

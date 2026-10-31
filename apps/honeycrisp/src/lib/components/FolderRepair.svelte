<!--
	A folder file that does not read as a folder, open to repair or delete.
	Once it reads, it is an ordinary folder in the list again.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';
	import { folderLabel, folderPath, getHoneycrisp } from '$lib/honeycrisp.svelte.js';
	import RepairDetail from './RepairDetail.svelte';

	const app = getHoneycrisp();
	const { folders } = app;
	let { id: shownId }: { id: string } = $props();

	// The parent keys this view by the folder.
	// svelte-ignore state_referenced_locally
	const id = shownId;
	const invalid = $derived(folders.invalid.find((file) => file.id === id));
	const repaired = $derived(folders.get({ id }));

	function confirmDelete() {
		const where = folders.where({ id });
		confirmationDialog.open({
			title: `Delete ${id}.md?`,
			description: `This deletes ${folderPath(id)} from ${where === 'repository' ? 'your repository' : 'this device'}. Notes that name it are kept, in All Notes.`,
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				const { error } = await app.deleteFolder(id);
				if (error !== null) toast.error('Could not delete the folder', { description: error.message });
			},
		});
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Folder">
	{#if invalid}
		<RepairDetail
			file={invalid}
			kind="folder"
			save={(text) => folders.replace({ id }, text)}
			onDelete={confirmDelete}
		/>
	{:else if repaired}
		<Empty.Root class="flex-1">
			<Empty.Title>“{folderLabel(repaired)}” reads as a folder</Empty.Title>
			<Button variant="outline" size="sm" onclick={() => (app.showFolder(id), app.open(undefined))}>Show its notes</Button>
		</Empty.Root>
	{:else}
		<Empty.Root class="flex-1">
			<Empty.Title>This folder is no longer here</Empty.Title>
			<Empty.Description>It was deleted, here or elsewhere.</Empty.Description>
		</Empty.Root>
	{/if}
</section>

<!--
	The desktop program's folder, where the web build links its two views:
	where Vocab keeps its files (`folder_path`), whether Epicenter syncs them
	(`syncedWithEpicenter`), "Sync with Epicenter" (`syncWithEpicenter`, which
	asks Epicenter through its `epicenter://init` link), and "Choose folder…",
	which waits for saves, then moves Vocab to the folder picked (a new
	window bound to it replaces this one).
-->
<script lang="ts">
	import { APPS } from '@epicenter/constants/apps';
	import { syncedWithEpicenter, syncWithEpicenter } from '@epicenter/folder/tauri';
	import { whenSaved } from '@epicenter/svelte/leave-guard';
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import { toast } from '@epicenter/ui/sonner';
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';

	/** Where Vocab publishes its contract (`static/contract.json`). */
	const CONTRACT_URL = `${APPS.VOCAB.url}/contract.json`;

	type FolderStatus = { path: string; synced: boolean };
	let status = $state<FolderStatus>();
	let problem = $state('');
	let note = $state('');
	let busy = $state(false);

	async function load() {
		try {
			const path = await invoke<string>('folder_path');
			const { data: synced, error } = await syncedWithEpicenter({ path });
			status = { path, synced: synced ?? false };
			problem = error === null ? '' : error.message;
		} catch (cause) {
			problem = extractErrorMessage(cause);
		}
	}

	// Epicenter may set the folder up while Vocab is open; look again on return.
	onMount(() => {
		void load();
		const focused = () => void load();
		window.addEventListener('focus', focused);
		return () => window.removeEventListener('focus', focused);
	});

	async function sync() {
		if (status === undefined) return;
		busy = true;
		note = '';
		const { error } = await syncWithEpicenter({ path: status.path, contract: CONTRACT_URL });
		busy = false;
		if (error !== null) {
			toast.error('Epicenter did not open', { description: error.message });
			return;
		}
		// The system took the request; whether Epicenter syncs is the learner's choice there.
		note = 'Asked your computer to open Epicenter. If it is installed, choose where to sync there.';
	}

	async function choose() {
		busy = true;
		await whenSaved();
		try {
			// A different folder moves Vocab to a new window bound to it.
			await invoke<boolean>('choose_folder');
		} catch (cause) {
			toast.error('Vocab could not use that folder', { description: extractErrorMessage(cause) });
		}
		busy = false;
	}
</script>

<Popover.Root>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} size="sm" variant="ghost" data-testid="folder-status">
				<span class="size-2 rounded-full {status?.synced ? 'bg-green-500' : 'bg-muted-foreground/50'}" aria-hidden="true"></span>
				{status === undefined ? 'Folder' : status.synced ? 'Synced by Epicenter' : 'Not synced'}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80 space-y-3 p-4" align="start">
		<p class="text-sm font-medium">Vocab's folder</p>
		{#if status}
			<p class="font-mono text-xs break-all" data-testid="folder-location">{status.path}</p>
			<p class="text-xs leading-relaxed text-muted-foreground">
				{#if status.synced}
					Your words and chats are Markdown files in this folder, and Epicenter keeps it in sync.
				{:else}
					Your words and chats are Markdown files in this folder, on this computer only. Sync with Epicenter to keep a history and reach them on your other devices.
				{/if}
			</p>
		{/if}
		{#if problem}<p role="alert" class="text-xs text-destructive">{problem}</p>{/if}
		<div class="flex flex-col gap-1">
			{#if !status?.synced}
				<Button size="sm" disabled={busy} onclick={() => void sync()}>Sync with Epicenter</Button>
			{/if}
			<Button size="sm" variant="outline" disabled={busy} onclick={() => void choose()}>Choose folder…</Button>
		</div>
		{#if note}<p role="status" class="text-xs text-muted-foreground">{note}</p>{/if}
	</Popover.Content>
</Popover.Root>

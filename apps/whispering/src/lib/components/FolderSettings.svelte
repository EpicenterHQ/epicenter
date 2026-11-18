<!--
	Where Whispering keeps its recordings (ADR-0894). On the desktop, the
	folder: its path, "Show in Finder", "Copy path", and "Change…", which
	picks another in the system's dialog (granting the app that folder and
	nothing else). An empty folder gets the recordings moved into it; a
	Whispering folder (one holding settings.md or recordings/) is opened, and
	the old one stays where it was, its path shown here so its recordings can
	be exported; any other folder is refused. Two folders are never merged.
	When the folder is in a Git repository, it says what that means for
	audio. In a browser, this site's storage: how much it holds, whether the
	browser keeps it, and an export of the whole folder, since a browser may
	clear its storage. Both show how much audio there is and delete audio
	older than a time the person picks; nothing deletes audio on its own.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from 'svelte-sonner';
	import { onMount } from 'svelte';
	import { createMutation } from '@tanstack/svelte-query';
	import { exportFolder, folderLocation, query } from '../app.js';
	import { getLibrary } from '../library.svelte.js';
	import { getWhispering } from '../whispering.svelte.js';
	import {
		changeFolder,
		type FolderGit,
		folderGit,
		folderPath,
		previousFolderPath,
	} from '../this-computer.js';

	const whispering = getWhispering();
	const path = folderLocation();
	/** A recording under way writes into this folder, so the folder stays until it stops. */
	const recording = $derived(whispering.recorder.phase !== 'idle');
	const previous = previousFolderPath.get();
	let git = $state<FolderGit | null>(null);
	let changing = $state(false);
	/** How old audio must be to be deleted, in days. */
	let olderThanDays = $state(365);
	const library = getLibrary();
	const deleteOldAudio = createMutation(() => query.folderMutations.audio.deleteBefore);
	const isMac = navigator.userAgent.includes('Mac');

	/** The browser's storage for this site: how much is used, and whether it is kept. */
	let usage = $state<{ bytes: number; persisted: boolean } | null>(null);
	let exporting = $state(false);

	onMount(() => {
		if (path !== null) {
			void folderGit(path).then(
				(found) => (git = found),
				() => (git = null),
			);
			return;
		}
		if (!navigator.storage?.estimate) return;
		void Promise.all([navigator.storage.estimate(), navigator.storage.persisted?.() ?? false]).then(
			([estimate, persisted]) => (usage = { bytes: estimate.usage ?? 0, persisted }),
		);
	});

	const size = (bytes: number) =>
		bytes < 1e6 ? `${Math.round(bytes / 1e3)} KB` : bytes < 1e9 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e9).toFixed(2)} GB`;

	async function reveal() {
		if (path === null) return;
		const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
		await revealItemInDir(path).catch((cause: unknown) =>
			toast.error('The folder could not be shown', { description: String(cause) }),
		);
	}

	async function copy() {
		if (path === null) return;
		await navigator.clipboard.writeText(path).then(
			() => toast.success('Copied the folder’s path'),
			(cause: unknown) => toast.error('The path was not copied', { description: String(cause) }),
		);
	}

	async function change() {
		if (path === null) return;
		const { open } = await import('@tauri-apps/plugin-dialog');
		const picked = await open({ directory: true, recursive: true, defaultPath: path, title: 'Choose an empty folder or a Whispering folder' });
		if (typeof picked !== 'string' || picked === path || recording) return;
		changing = true;
		const changed = await changeFolder(path, picked).then(
			(done) => ({ done, problem: null }),
			(cause: unknown) => ({ done: null, problem: cause instanceof Error ? cause.message : String(cause) }),
		);
		changing = false;
		if (changed.done === null)
			return toast.error('The folder was not changed', { description: changed.problem ?? undefined });
		folderPath.set(picked);
		previousFolderPath.set(changed.done === 'opened' ? path : null);
		location.reload();
	}

	function confirmDeleteOldAudio() {
		const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
		if (!confirm(`Delete the audio of every recording made before ${cutoff.toLocaleDateString()}? Their notes and transcripts stay. This cannot be undone.`))
			return;
		deleteOldAudio.mutate(
			{ cutoff },
			{
				onError: (error) => toast.error('Not all of that audio was deleted', { description: error.message }),
				onSuccess: (count) =>
					toast.success(count === 0 ? 'No audio was that old' : `Deleted the audio of ${count} recording${count === 1 ? '' : 's'}`),
			},
		);
	}

	async function download() {
		exporting = true;
		const zip = await exportFolder();
		exporting = false;
		if (typeof zip === 'string') return toast.error('Nothing was exported', { description: zip });
		if (zip.error !== null) return toast.error('Nothing was exported', { description: zip.error });
		const url = URL.createObjectURL(zip.data);
		const link = document.createElement('a');
		link.href = url;
		link.download = `whispering-${new Date().toISOString().slice(0, 10)}.zip`;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	}
</script>

<section class="flex flex-col gap-2 text-xs" data-testid="folder-settings">
	<p class="text-sm font-medium">Recordings</p>
	{#if path !== null}
		<p class="text-muted-foreground">Kept in this folder on this computer: a Markdown note per recording beside its audio, and <code>settings.md</code>.</p>
		<code class="break-all rounded border px-2 py-1 font-mono" data-testid="folder-path">{path}</code>
		<div class="flex flex-wrap gap-1">
			<Button size="xs" variant="outline" onclick={() => void reveal()}>{isMac ? 'Show in Finder' : 'Show folder'}</Button>
			<Button size="xs" variant="outline" onclick={() => void copy()}>Copy path</Button>
			<Button size="xs" variant="outline" disabled={changing || recording} title={recording ? 'Stop the recording to change the folder' : undefined} onclick={() => void change()} data-testid="folder-change">Change…</Button>
		</div>
		<p class="text-muted-foreground">
			Pick an empty folder to move the recordings into it, or a Whispering folder to open it instead; the folder you leave stays as it is. Removing Whispering’s app data, as an uninstaller or a cleaner may, removes a folder kept there.
		</p>
		{#if previous !== null}
			<p class="text-muted-foreground" data-testid="folder-previous">
				The recordings you had before are still in <code class="break-all font-mono">{previous}</code>; copy them from there to keep them.
			</p>
		{/if}
		{#if git?.repository}
			{#if !git.lfsWebm}
				<p class="text-amber-600 dark:text-amber-400" data-testid="folder-git-lfs">
					This folder is in a Git repository with no Git LFS rule for <code>.webm</code>, so a commit would put each recording’s audio into Git whole.
				</p>
			{/if}
			<p class="text-muted-foreground" data-testid="folder-git-history">
				Audio you delete here stays in the Git repository’s history: deleting it frees space in this folder, not in the repository.
			</p>
		{/if}
	{:else}
		<p class="text-muted-foreground">
			Kept in this browser’s storage for this site{#if usage}, {size(usage.bytes)}{/if}. {#if usage && !usage.persisted}The browser may clear it when space runs low, so export what you want to keep.{:else}Clearing this site’s data removes them, so export what you want to keep.{/if}
		</p>
		<div class="flex flex-wrap gap-1">
			<Button size="xs" variant="outline" disabled={exporting} onclick={() => void download()} data-testid="folder-export">Export as zip</Button>
		</div>
	{/if}
	<p class="text-muted-foreground" data-testid="folder-audio-size">Audio: {size(library.audioSize)}. Whispering keeps it until you delete it.</p>
	<div class="flex flex-wrap items-center gap-1">
		<label class="text-muted-foreground" for="older-than">Delete audio older than</label>
		<select id="older-than" class="rounded border bg-transparent px-1 py-0.5" bind:value={olderThanDays}>
			<option value={30}>30 days</option>
			<option value={90}>90 days</option>
			<option value={365}>a year</option>
		</select>
		<Button size="xs" variant="outline" disabled={deleteOldAudio.isPending} onclick={confirmDeleteOldAudio} data-testid="folder-delete-old-audio">Delete…</Button>
	</div>
</section>

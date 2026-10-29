<!--
	Files over the repository the shell opened: the folder its path names,
	and the file, when the path names one (`tree.ts`). It reads every file
	through the plain file API, so it shows any repository, in a collection
	or none. A new file is made in the folder shown; the file opens in its
	own view, to edit, rename or delete.
-->
<script lang="ts">
	import { fileOfPath, pathOfFile } from '@epicenter/app';
	import type { FileEntry } from '@epicenter/repository';
	import type { AppProps } from '@epicenter/svelte/app';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FileView from './FileView.svelte';
	import type { manifest } from './manifest.js';
	import { folderOfPath, inFolder, listingOf, nameOf, newPathProblem, parentOf, pathOfFolder } from './tree.js';

	let { repo, path, navigate }: AppProps<typeof manifest> = $props();

	/** The file the path names, if it names one. */
	const file = $derived(fileOfPath(path));
	/** The folder shown: the one the path names, or the file's. */
	const folder = $derived(file === undefined ? (folderOfPath(path) ?? '') : parentOf(file));

	/** Every file, as of the last change; undefined until first listed. */
	let files = $state.raw<readonly FileEntry[]>();
	$effect(() => {
		repo.revision();
		let current = true;
		void repo.files.list().then(({ data }) => {
			if (current && data !== null) files = data;
		});
		return () => {
			current = false;
		};
	});
	const listing = $derived(files === undefined ? undefined : listingOf(files, folder));
	/** The folder's ancestors, from the root, for the breadcrumbs. */
	const crumbs = $derived(folder === '' ? [] : folder.split('/').map((name, index, all) => ({ name, folder: all.slice(0, index + 1).join('/') })));

	let name = $state('');
	let refusal = $state<string>();
	let uploadRefusal = $state<string>();
	let picker = $state<HTMLInputElement>();
	async function create(event: SubmitEvent) {
		event.preventDefault();
		if (files === undefined) return;
		const at = inFolder(folder, name.trim());
		refusal = newPathProblem(files, at);
		if (refusal !== undefined) return;
		const created = await repo.files.create(at, '');
		if (created.error !== null) {
			refusal = created.error.message;
			return;
		}
		name = '';
		await navigate(pathOfFile(at));
	}

	async function addFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const picked = input.files?.[0];
		input.value = '';
		if (picked === undefined || files === undefined) return;
		const at = inFolder(folder, picked.name);
		const problem = newPathProblem(files, at);
		uploadRefusal = problem?.startsWith('A file is already at ') ? `A file named ${picked.name} is already here.` : problem;
		if (uploadRefusal !== undefined) return;
		let created;
		try {
			created = at.toLowerCase().endsWith('.md') ? await repo.files.create(at, await picked.text()) : await repo.files.create(at, picked);
		} catch {
			uploadRefusal = `Could not read ${picked.name}.`;
			return;
		}
		if (created.error !== null) {
			const error = created.error;
			switch (error.name) {
				case 'Exists': uploadRefusal = `A file named ${picked.name} is already here.`; break;
				case 'TooLarge': uploadRefusal = `This file is too large. The limit is ${(error.limit / 1_000_000).toFixed(1)} MB.`; break;
				case 'QuotaExceeded': uploadRefusal = 'This device has no room left for this file.'; break;
				case 'Unavailable': uploadRefusal = 'The repository is unavailable. Try again when it opens.'; break;
				default: uploadRefusal = error.message;
			}
			return;
		}
		uploadRefusal = undefined;
		await navigate(pathOfFile(at));
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	<header class="flex h-12 shrink-0 items-center gap-1 border-b px-3 text-sm">
		<h1 class="mr-2 font-semibold">Files</h1>
		<nav class="flex min-w-0 items-center gap-0.5" aria-label="Breadcrumbs">
			<Button size="sm" variant="ghost" onclick={() => void navigate('/')}>Root</Button>
			{#each crumbs as crumb (crumb.folder)}
				<span class="text-muted-foreground">/</span>
				<Button size="sm" variant="ghost" class="min-w-0 truncate" onclick={() => void navigate(pathOfFolder(crumb.folder))}>{crumb.name}</Button>
			{/each}
		</nav>
	</header>

	<div class="flex min-h-0 flex-1">
		<section class="flex w-72 shrink-0 flex-col overflow-y-auto border-r" aria-label="Folder">
			{#if listing === undefined}
				<p class="p-3 text-sm text-muted-foreground">Listing…</p>
			{:else}
				<ul class="flex-1 py-1 text-sm" aria-label="In {folder === '' ? 'the root' : folder}">
					{#if folder !== ''}
						<li><button type="button" class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-muted-foreground hover:bg-muted" onclick={() => void navigate(pathOfFolder(parentOf(folder)))}>..</button></li>
					{/if}
					{#each listing.folders as child (child)}
						<li>
							<button type="button" class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted" data-folder={inFolder(folder, child)} onclick={() => void navigate(pathOfFolder(inFolder(folder, child)))}>
								<FolderIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
								<span class="truncate">{child}/</span>
							</button>
						</li>
					{/each}
					{#each listing.files as entry (entry.path)}
						<li>
							<button
								type="button"
								class={['flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted', entry.path === file && 'bg-muted font-medium']}
								aria-current={entry.path === file ? 'page' : undefined}
								data-file={entry.path}
								onclick={() => void navigate(pathOfFile(entry.path))}
							>
								<FileTextIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
								<span class="min-w-0 flex-1 truncate">{nameOf(entry.path)}</span>
								{#if entry.state.status !== 'synced'}
									<span class="text-xs text-muted-foreground">{entry.state.status === 'held' ? 'Held' : 'Not sent'}</span>
								{/if}
							</button>
						</li>
					{:else}
						{#if listing.folders.length === 0}
							<li class="px-3 py-1.5 text-muted-foreground">No files here yet</li>
						{/if}
					{/each}
				</ul>
				<form class="space-y-2 border-t p-3" aria-label="New file" onsubmit={create}>
					<label class="block space-y-1 text-sm">
						<span>New file in {folder === '' ? 'the root' : folder}</span>
						<Input bind:value={name} placeholder="name.md" />
					</label>
					{#if refusal !== undefined}
						<p class="text-xs text-destructive" role="alert">{refusal}</p>
					{/if}
					<Button type="submit" size="sm">Create</Button>
				</form>
				<div class="space-y-2 border-t p-3">
				<input bind:this={picker} type="file" class="sr-only" aria-label="Choose file to add" onchange={(event) => void addFile(event)} />
				<Button type="button" size="sm" variant="outline" onclick={() => picker?.click()}>Add file</Button>
				{#if uploadRefusal !== undefined}<p class="text-xs text-destructive" role="alert">{uploadRefusal}</p>{/if}
				</div>
			{/if}
		</section>

		<div class="min-w-0 flex-1">
			{#if file !== undefined}
				{#key file}
					<FileView
						{repo}
						path={file}
						{files}
						onRenamed={(to) => void navigate(pathOfFile(to), { replace: true })}
						onDeleted={() => void navigate(pathOfFolder(parentOf(file)), { replace: true })}
					/>
				{/key}
			{:else}
				<Empty.Root class="h-full">
					<Empty.Title>Choose a file</Empty.Title>
					<Empty.Description>Every file of this repository is here, whichever app wrote it.</Empty.Description>
				</Empty.Root>
			{/if}
		</div>
	</div>
</div>

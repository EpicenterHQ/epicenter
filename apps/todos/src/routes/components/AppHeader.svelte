<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import type { SyncError, SyncOutcome } from '@epicenter/folder';
	import StatusPopover, { toastStatus } from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderGitIcon from '@lucide/svelte/icons/folder-git-2';
	import LinkIcon from '@lucide/svelte/icons/link';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import {
		type CreateMutationResult,
		createMutation,
		createQuery,
		useIsMutating,
	} from '@tanstack/svelte-query';
	import { Err, Ok } from 'wellcrafted/result';
	import {
		filesLine,
		lastVersionLine,
		pushLine,
		remoteLabel,
		summaryLine,
		syncOutcomeLine,
		versionLine,
		versionOutcomeLine,
	} from '$lib/status.js';
	import { describeError } from '$lib/describe-error.js';
	import { isEpicenter } from '$lib/remote.js';
	import type { TodosError } from '$lib/session.js';
	import type { ConnectTo } from '$lib/sync.js';
	import { getTodos } from '$lib/todos.svelte.js';

	const todos = getTodos();

	let {
		sync,
		onconnect,
	}: {
		/** The page's Sync. */
		sync: CreateMutationResult<SyncOutcome, SyncError | TodosError, ConnectTo | void, unknown>;
		/**
		 * Open Connect, to choose or change the remote. Absent for a folder
		 * that offers no Connect: the remote is shown and cannot be changed here.
		 */
		onconnect?: () => void;
	} = $props();

	// Git status is a read like any other: on open, when the folder reports a
	// change, and after the app's own saves and actions.
	const status = createQuery(() => todos.git.status.options);
	const saveVersion = createMutation(() => todos.git.saveVersion.options);
	const writing = useIsMutating(todos.writing);
	const files = $derived(filesLine({ saving: writing.current > 0 }));
	const versions = $derived(versionLine(todos.git.snapshot));
	const lastVersion = $derived(lastVersionLine(todos.git.snapshot));
	const remote = $derived(pushLine(todos.git.snapshot));
	const summary = $derived(summaryLine({ files, versions, lastVersion, remote }));

	async function copyPath(path: string) {
		try {
			await navigator.clipboard.writeText(path);
			toast.success(`Copied ${path}`);
		} catch {
			toast.error('Could not copy the path', { description: path });
		}
	}

	/** The directory on this computer, when the todos are in one. */
	const directory = $derived(
		todos.folder.location.kind === 'directory' ? todos.folder.location.root : undefined,
	);
	const connected = $derived(todos.git.snapshot.remote);

	/** Sync and Save version wait for each other. */
	const busy = $derived(sync.isPending || saveVersion.isPending);

	function runSync() {
		sync.mutate(undefined, {
			onSettled: (outcome, error) => {
				toastStatus(syncOutcomeLine(error ? Err(error) : Ok(outcome!), todos.git.snapshot));
			},
		});
	}

	function runSaveVersion() {
		saveVersion.mutate(undefined, {
			onSuccess: (outcome) => toastStatus(versionOutcomeLine(outcome)),
			onError: (error) => toast.error('Version not saved', { description: describeError(error) }),
		});
	}
</script>

<header class="flex h-12 shrink-0 items-center gap-1.5 border-b px-2 sm:gap-2 sm:px-3">
	<!-- On narrow screens the list itself says what this is; the width goes to status. -->
	<h1 class="text-sm font-semibold max-sm:sr-only">Todos</h1>
	{#if directory !== undefined}
		<!-- The files are ordinary files; say where, so any program can open them. -->
		<Button
			variant="ghost"
			size="sm"
			class="max-w-88 min-w-0 shrink font-mono text-xs font-normal text-muted-foreground max-md:hidden"
			tooltip="Your todos are files in this folder. Click to copy its path."
			aria-label="Todos folder: {directory}. Copy path"
			data-testid="folder-path"
			onclick={() => void copyPath(directory)}
		>
			<FolderIcon />
			<span class="truncate">{directory}</span>
		</Button>
	{/if}
	<!-- Where the todos sync: a repository, a URL, or nowhere yet. -->
	<Button
		variant="ghost"
		size="sm"
		class="max-w-56 min-w-0 shrink font-normal"
		tooltip={onconnect === undefined
			? 'Todos connects only its own folder to a remote.'
			: connected === undefined ? 'Choose where your todos sync' : `Syncs with ${connected.url}. Click to change.`}
		aria-label={connected === undefined
			? `Not connected${onconnect === undefined ? '' : '. Connect'}`
			: `Syncs with ${remoteLabel(connected.url, isEpicenter)}${onconnect === undefined ? '' : '. Change remote'}`}
		disabled={busy || onconnect === undefined}
		data-testid="remote"
		onclick={onconnect}
	>
		{#if connected === undefined}<LinkIcon />{:else}<FolderGitIcon />{/if}
		<span class="truncate max-sm:sr-only">{connected === undefined ? 'Not connected' : remoteLabel(connected.url, isEpicenter)}</span>
	</Button>

	<StatusPopover
		{summary}
		details={[
			{ name: 'Files', testid: 'status-files', line: files },
			{ name: 'Changes', testid: 'status-history', line: versions },
			{ name: 'Last version', testid: 'status-last-version', line: lastVersion },
			{ name: 'Remote', testid: 'status-remote', line: remote },
		]}
	>
		<StatusRow name="Folder">
			{#if directory !== undefined}
				<span class="block font-mono text-xs break-all select-all" data-testid="status-folder">{directory}</span>
				<span class="mt-0.5 block text-xs text-muted-foreground">
					Each todo is a file in <code>todos/</code> here. Edits made by other programs show up here as they happen.
				</span>
				<Button class="mt-1.5" variant="outline" size="sm" onclick={() => void copyPath(directory)}>Copy path</Button>
			{:else}
				<span class="font-medium" data-testid="status-folder">This browser</span>
				<span class="mt-0.5 block text-xs text-muted-foreground">Saved in this browser's storage, not in a folder on this computer.</span>
			{/if}
		</StatusRow>
		{#snippet footer()}
			<Button
				variant="outline"
				size="sm"
				disabled={status.isFetching}
				onclick={() => void todos.refresh()}
			>
				Check again
			</Button>
		{/snippet}
	</StatusPopover>

	<div class="ml-auto flex shrink-0 items-center gap-1.5">
		<Button
			variant="outline"
			size="sm"
			disabled={busy}
			tooltip="Record the saved files as a version in history. Nothing is sent."
			data-testid="save-version"
			onclick={runSaveVersion}
		>
			{#if saveVersion.isPending}<Spinner class="size-3.5" />{:else}<HistoryIcon />{/if}
			<span class="max-sm:sr-only">Save version</span>
		</Button>
		{#if connected === undefined}
			{#if onconnect !== undefined}
				<Button size="sm" disabled={busy} tooltip="Choose where your todos sync" data-testid="connect-open" onclick={onconnect}>
					<LinkIcon />
					<span class="max-sm:sr-only">Connect</span>
				</Button>
			{/if}
		{:else}
			<Button
				size="sm"
				disabled={busy}
				tooltip="Save a version, get the remote, combine them, and send the result. Conflicts ask you first."
				data-testid="sync"
				onclick={runSync}
			>
				{#if sync.isPending}<Spinner class="size-3.5" />{:else}<RefreshCwIcon />{/if}
				<span class="max-sm:sr-only">Sync</span>
			</Button>
		{/if}
	</div>
</header>

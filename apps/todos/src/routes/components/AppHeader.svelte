<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import type { SyncError, SyncOutcome } from '@epicenter/folder';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import PanelLeftIcon from '@lucide/svelte/icons/panel-left';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import {
		type CreateMutationResult,
		createMutation,
		createQuery,
	} from '@tanstack/svelte-query';
	import { Err, Ok } from 'wellcrafted/result';
	import {
		filesLine,
		INCOMING_WAITS,
		incomingLine,
		lastVersionLine,
		pushLine,
		type StatusLine,
		summaryLine,
		syncOutcomeLine,
		versionLine,
		versionOutcomeLine,
	} from '$lib/status.js';
	import { describeError } from '$lib/describe-error.js';
	import { getTodos, type TodosError } from '$lib/todos.svelte.js';
	import { copyPath } from './file-actions.js';

	const todos = getTodos();

	let {
		sync,
		reviewing = false,
		filesOpen,
		terminalOpen,
		onToggleFiles,
		onToggleTerminal,
	}: {
		/** The page's Sync; a sync that needs choices opens the review the page shows. */
		sync: CreateMutationResult<SyncOutcome, SyncError | TodosError, void, unknown>;
		/** Whether the sync review shows, which holds every other Git action. */
		reviewing?: boolean;
		filesOpen: boolean;
		terminalOpen: boolean;
		onToggleFiles: () => void;
		onToggleTerminal: () => void;
	} = $props();

	// Git status is a read like any other: on open, on focus, and after actions.
	const status = createQuery(() => todos.statusQuery());
	const saveVersion = createMutation(() => todos.saveVersion.options);
	const files = $derived(filesLine({ saving: todos.saving }));
	const incoming = $derived(incomingLine(todos.git));
	const versions = $derived(versionLine(todos.git));
	const lastVersion = $derived(lastVersionLine(todos.git));
	const remote = $derived(pushLine(todos.git));
	const summary = $derived(summaryLine({ files, incoming, versions, lastVersion, remote }));
	const details = $derived<[string, string, StatusLine | undefined][]>([
		['Incoming', 'status-incoming', incoming],
		['Files', 'status-files', files],
		['Changes', 'status-history', versions],
		['Last version', 'status-last-version', lastVersion],
		['Remote', 'status-remote', remote],
	]);

	/** The directory on this computer, when the todos are in one. */
	const directory = $derived(
		todos.folder.location.kind === 'directory' ? todos.folder.location.root : undefined,
	);
	/** Whether this folder syncs; a desktop folder records versions but does not sync yet. */
	const syncs = $derived(todos.folder.sync.supported);
	const hasRemote = $derived(todos.git.remote !== undefined);
	const NO_REMOTE = 'This folder has no Git remote, so there is nothing to sync with.';

	const tones: Record<StatusLine['tone'], string> = {
		neutral: 'bg-muted-foreground/50',
		busy: 'bg-primary animate-pulse',
		good: 'bg-success',
		warning: 'bg-warning',
		error: 'bg-destructive',
	};

	/** Sync and Save version wait for each other, the review, recovery, and a departure. */
	const busy = $derived(
		sync.isPending ||
			saveVersion.isPending ||
			reviewing ||
			todos.departing ||
			todos.recovering,
	);
	/**
	 * Sync and Save version wait while an incoming update is pending; the
	 * folder refuses them anyway, so they are off until it is recovered.
	 * Editing is not affected.
	 */
	const pending = $derived(todos.git.pendingIncoming !== undefined);

	/** Outcome toasts use the status lines' wording, so the toast and the details agree. */
	const notify: Record<StatusLine['tone'], typeof toast.info> = {
		good: toast.success,
		neutral: toast.info,
		busy: toast.info,
		warning: toast.warning,
		error: toast.error,
	};
	const show = (line: StatusLine) => notify[line.tone](line.label, { description: line.detail });

	/** Sync; conflicts open the review instead of a toast. */
	function runSync() {
		sync.mutate(undefined, {
			onSettled: (outcome, error) => {
				if (error?.name === 'NeedsChoices') return;
				show(syncOutcomeLine(error ? Err(error) : Ok(outcome!), todos.git));
			},
		});
	}

	function runSaveVersion() {
		saveVersion.mutate(undefined, {
			onSuccess: (outcome) => show(versionOutcomeLine(outcome)),
			onError: (error) => toast.error('Version not saved', { description: describeError(error) }),
		});
	}
</script>

<header class="flex h-12 shrink-0 items-center gap-1.5 border-b px-2 sm:gap-2 sm:px-3">
	<Button
		variant="ghost"
		size="icon-sm"
		tooltip={filesOpen ? 'Hide files (Ctrl+B)' : 'Show files (Ctrl+B)'}
		aria-label="Files"
		aria-pressed={filesOpen}
		onclick={onToggleFiles}
	>
		<PanelLeftIcon />
	</Button>
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

	<Popover.Root>
		<Popover.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					variant="ghost"
					size="sm"
					class="min-w-0 shrink font-normal text-muted-foreground"
					aria-label="Status: {summary.label}. Show details"
					data-testid="status-summary"
				>
					<span class="size-2 shrink-0 rounded-full {tones[summary.tone]}" aria-hidden="true"></span>
					<span class="truncate sm:hidden">{summary.short ?? summary.label}</span>
					<span class="truncate max-sm:hidden">{summary.label}</span>
					<ChevronDownIcon class="text-muted-foreground max-sm:hidden" />
				</Button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content align="start" class="w-80 max-w-[calc(100vw-1rem)] p-0">
			<dl class="divide-y text-sm">
				<div class="grid grid-cols-[5.5rem_1fr] gap-x-3 px-3 py-2">
					<dt class="text-xs text-muted-foreground">Folder</dt>
					<dd class="min-w-0">
						{#if directory !== undefined}
							<span class="block font-mono text-xs break-all select-all" data-testid="status-folder">{directory}</span>
							<span class="mt-0.5 block text-xs text-muted-foreground">
								Each todo is a file in <code>todos/</code> here. Edits made by other programs show up when you return to this window.
							</span>
							<Button class="mt-1.5" variant="outline" size="sm" onclick={() => void copyPath(directory)}>Copy path</Button>
						{:else}
							<span class="font-medium" data-testid="status-folder">This browser</span>
							<span class="mt-0.5 block text-xs text-muted-foreground">Saved in this browser's storage, not in a folder on this computer.</span>
						{/if}
					</dd>
				</div>
				{#each details as [name, testid, line] (name)}
					{#if line}
						<div class="grid grid-cols-[5.5rem_1fr] gap-x-3 px-3 py-2">
							<dt class="text-xs text-muted-foreground">{name}</dt>
							<dd class="min-w-0">
								<span class="flex items-center gap-1.5 font-medium" data-testid={testid}>
									<span class="size-2 shrink-0 rounded-full {tones[line.tone]}" aria-hidden="true"></span>
									{line.label}
								</span>
								{#if line.detail}
									<span class="mt-0.5 block text-xs break-words whitespace-pre-line text-muted-foreground">{line.detail}</span>
								{/if}
							</dd>
						</div>
					{/if}
				{/each}
			</dl>
			<div class="flex items-center gap-2 border-t px-3 py-2">
				<Button
					variant="outline"
					size="sm"
					disabled={status.isFetching}
					onclick={() => void todos.refresh()}
				>
					Check again
				</Button>
			</div>
		</Popover.Content>
	</Popover.Root>

	<div class="ml-auto flex shrink-0 items-center gap-1.5">
		<Button
			variant="outline"
			size="sm"
			disabled={busy || pending}
			tooltip={pending ? INCOMING_WAITS : 'Record the saved files as a version in history. Nothing is sent.'}
			data-testid="save-version"
			onclick={runSaveVersion}
		>
			{#if saveVersion.isPending}<Spinner class="size-3.5" />{:else}<HistoryIcon />{/if}
			<span class="max-sm:sr-only">Save version</span>
		</Button>
		<!-- Where the folder syncs (the browser demo); a desktop folder does not sync yet. -->
		{#if syncs}
			<Button
				size="sm"
				disabled={busy || !hasRemote || pending}
				tooltip={!hasRemote
					? NO_REMOTE
					: pending
						? INCOMING_WAITS
						: 'Save a version, get the remote, combine them, and send the result. Conflicts ask you first.'}
				data-testid="sync"
				onclick={runSync}
			>
				{#if sync.isPending}<Spinner class="size-3.5" />{:else}<RefreshCwIcon />{/if}
				<span class="max-sm:sr-only">Sync</span>
			</Button>
		{/if}
		<Button
			variant={terminalOpen ? 'secondary' : 'ghost'}
			size="icon-sm"
			tooltip={terminalOpen ? 'Hide terminal (Ctrl+`)' : 'Show terminal (Ctrl+`)'}
			aria-label="Terminal"
			aria-pressed={terminalOpen}
			data-terminal-toggle
			onclick={onToggleTerminal}
		>
			<SquareTerminalIcon />
		</Button>
	</div>
</header>

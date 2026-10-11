<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import ArrowDownToLineIcon from '@lucide/svelte/icons/arrow-down-to-line';
	import ArrowUpFromLineIcon from '@lucide/svelte/icons/arrow-up-from-line';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import GitMergeIcon from '@lucide/svelte/icons/git-merge';
	import PanelLeftIcon from '@lucide/svelte/icons/panel-left';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import {
		commitAndPushToast,
		commitLine,
		filesLine,
		INCOMING_WAITS,
		incomingLine,
		mergeLine,
		mergeOutcomeLine,
		pullLine,
		pullOutcomeLine,
		pushLine,
		type StatusLine,
		summaryLine,
		syncOutcomeLine,
		uncommittedLine,
	} from '$lib/status.js';
	import type { Todos } from '$lib/todos.svelte.js';
	import { copyPath } from './file-actions.js';

	let {
		todos,
		filesOpen,
		terminalOpen,
		onToggleFiles,
		onToggleTerminal,
	}: {
		todos: Todos;
		filesOpen: boolean;
		terminalOpen: boolean;
		onToggleFiles: () => void;
		onToggleTerminal: () => void;
	} = $props();

	const files = $derived(
		filesLine({ saving: todos.saving, problems: todos.saveProblems, unsaved: todos.unsaved }),
	);
	const incoming = $derived(incomingLine(todos.git));
	const uncommitted = $derived(uncommittedLine(todos.git));
	const commit = $derived(commitLine(todos.git));
	const remote = $derived(pushLine(todos.git));
	const pull = $derived(pullLine(todos.git));
	const merge = $derived(mergeLine(todos.git));
	const summary = $derived(summaryLine({ files, incoming, uncommitted, commit, remote }));
	const details = $derived<[string, string, StatusLine | undefined][]>([
		['Incoming', 'status-incoming', incoming],
		['Files', 'status-files', files],
		['Changes', 'status-history', uncommitted],
		['Last commit', 'status-last-commit', commit],
		['Remote', 'status-remote', remote],
		['Last pull', 'status-pull', pull],
		['Last merge', 'status-merge', merge],
	]);

	/** The directory on this computer, when the todos are in one. */
	const directory = $derived(
		todos.folder.location.kind === 'directory' ? todos.folder.location.root : undefined,
	);
	/** Whether this folder syncs; a desktop folder offers its Git actions instead. */
	const syncs = $derived(todos.folder.sync.supported);
	/** Pull, fetch, and push need a remote; a desktop folder starts without one. */
	const hasRemote = $derived(todos.git.remote !== undefined);
	const NO_REMOTE =
		'This folder has no Git remote, so there is nothing to pull from or push to.';
	/**
	 * Offered when the last check saw commits on both sides. Pull stays
	 * fast-forward only.
	 */
	const offerMerge = $derived(
		hasRemote &&
			todos.git.sync.state === 'observed' &&
			todos.git.sync.value.ahead > 0 &&
			todos.git.sync.value.behind > 0,
	);

	const tones: Record<StatusLine['tone'], string> = {
		neutral: 'bg-muted-foreground/50',
		busy: 'bg-primary animate-pulse',
		good: 'bg-success',
		warning: 'bg-warning',
		error: 'bg-destructive',
	};

	let working = $state<'commit' | 'pull' | 'fetch' | 'merge' | 'sync' | undefined>();
	const busy = $derived(
		working !== undefined ||
			todos.syncing ||
			todos.syncAttempt !== undefined ||
			todos.recovering ||
			todos.git.activity.commit.active ||
			todos.git.activity.push.active ||
			todos.git.activity.pull.active ||
			todos.git.activity.merge.active,
	);
	/**
	 * Commits, pulls, and merges wait while an incoming update is pending;
	 * the folder refuses them anyway, so they are off until it is recovered.
	 * Fetch and ordinary editing are not affected.
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

	async function commitAndPush() {
		working = 'commit';
		try {
			show(commitAndPushToast(await todos.commitAndPush(), todos.git));
		} finally {
			working = undefined;
		}
	}

	async function fetchRemote() {
		working = 'fetch';
		try {
			const { data: fetched, error: fetchError } = await todos.fetch();
			if (fetchError) toast.error('Fetch failed', { description: fetchError.message });
			else if (fetched.oid === undefined) toast.info('The remote has no commits yet.');
			else toast.success(`Fetched ${fetched.oid.slice(0, 7)}.`);
		} finally {
			working = undefined;
		}
	}

	async function pullRemote() {
		working = 'pull';
		try {
			show(pullOutcomeLine(await todos.pull()));
		} finally {
			working = undefined;
		}
	}

	/** Sync; conflicts open the review instead of a toast. */
	async function syncRemote() {
		working = 'sync';
		try {
			const ran = await todos.sync();
			if (ran.data?.kind !== 'needsChoices') show(syncOutcomeLine(ran, todos.git));
		} finally {
			working = undefined;
		}
	}

	async function mergeRemote() {
		working = 'merge';
		try {
			show(mergeOutcomeLine(await todos.merge()));
		} finally {
			working = undefined;
		}
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
								Each todo is a file in <code>todos/</code> here. Edits made by other programs show up in this window.
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
				<Button variant="outline" size="sm" onclick={() => void todos.check()}>Check again</Button>
				<Button
					variant="ghost"
					size="sm"
					disabled={busy || !hasRemote}
					tooltip={hasRemote ? 'Download the remote history without changing files' : NO_REMOTE}
					onclick={fetchRemote}
				>
					{#if working === 'fetch'}<Spinner class="size-3.5" />{/if}
					Fetch
				</Button>
			</div>
		</Popover.Content>
	</Popover.Root>

	<div class="ml-auto flex shrink-0 items-center gap-1.5">
		<!-- Sync replaces Pull, Merge, and Commit and push wherever the folder syncs; a desktop folder keeps them until it does. -->
		{#if syncs}
			<Button
				size="sm"
				disabled={busy || !hasRemote || pending}
				tooltip={!hasRemote
					? NO_REMOTE
					: pending
						? INCOMING_WAITS
						: 'Save your changes to history, get the remote, combine them, and push. Conflicts ask you first.'}
				data-testid="sync"
				onclick={syncRemote}
			>
				{#if working === 'sync'}<Spinner class="size-3.5" />{:else}<RefreshCwIcon />{/if}
				<span class="max-sm:sr-only">Sync</span>
			</Button>
		{:else}
			{#if offerMerge}
				<Button
					variant="outline"
					size="sm"
					disabled={busy || pending}
					tooltip={pending ? INCOMING_WAITS : "Combine the remote's commits with yours in a new commit. Nothing is pushed."}
					data-testid="merge-incoming"
					onclick={mergeRemote}
				>
					{#if working === 'merge'}<Spinner class="size-3.5" />{:else}<GitMergeIcon />{/if}
					<span class="max-sm:sr-only">Merge incoming changes</span>
				</Button>
			{/if}
			<Button
				variant="outline"
				size="sm"
				disabled={busy || !hasRemote || pending}
				tooltip={!hasRemote
					? NO_REMOTE
					: pending
						? INCOMING_WAITS
						: 'Get commits from the remote. Only a clean fast-forward is applied.'}
				data-testid="pull"
				onclick={pullRemote}
			>
				{#if working === 'pull'}<Spinner class="size-3.5" />{:else}<ArrowDownToLineIcon />{/if}
				<span class="max-sm:sr-only">Pull</span>
			</Button>
			<Button
				size="sm"
				disabled={busy || pending}
				tooltip={pending
					? INCOMING_WAITS
					: hasRemote
						? 'Commit the saved files and push to the remote.'
						: 'Commit the saved files. There is no remote to push to.'}
				data-testid="commit-and-push"
				onclick={commitAndPush}
			>
				{#if working === 'commit'}<Spinner class="size-3.5" />{:else}<ArrowUpFromLineIcon class="sm:hidden" />{/if}
				<span class="max-sm:sr-only">{hasRemote ? 'Commit and push' : 'Commit'}</span>
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

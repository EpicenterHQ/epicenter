<script lang="ts">
	import type { CommitSummary } from '@epicenter/folder';
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import { toast } from '@epicenter/ui/sonner';
	import StatusPopover, { toastStatus } from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import { createQuery } from '@tanstack/svelte-query';
	import { getAbortSignal } from 'svelte';
	import { describeError, type Notes, notesKeys } from '$lib/notes.svelte.js';
	import {
		changesLine,
		commitOutcomeLine,
		historyLine,
		savesLine,
		summaryLine,
	} from '$lib/status.js';

	let {
		notes,
		filesOpen,
		onToggleFiles,
	}: {
		notes: Notes;
		filesOpen: boolean;
		onToggleFiles: () => void;
	} = $props();

	// Observed so Git status is read again when the folder reports a change and
	// after the app's own saves and actions; the lines below read the snapshot
	// that read updates.
	createQuery(() => notes.folder$.history.status.queryOptions());

	const saves = $derived(savesLine({ saving: notes.saving, unsaved: notes.unsaved }));
	const changes = $derived(changesLine(notes.git));
	const history = $derived(historyLine(notes.git));
	const summary = $derived(summaryLine({ saves, changes, history }));
	const savingVersion = $derived(notes.mutating({ mutationKey: notesKeys.saveVersion }) > 0);

	let open = $state(false);
	let log = $state.raw<CommitSummary[] | string>([]);

	// Read the recent versions whenever the details open or history moves.
	$effect(() => {
		if (!open) return;
		notes.git.lastCommit;
		const signal = getAbortSignal();
		void notes.folder.git.log(8).then(
			({ data: commits, error: historyError }) => {
				if (signal.aborted) return;
				log = historyError ? historyError.message : commits;
			},
			(cause) => {
				if (signal.aborted) return;
				log = cause instanceof Error ? cause.message : String(cause);
			},
		);
	});

	/** Record a version of every saved file (ADR-0529). */
	async function saveVersion() {
		const { data: outcome, error } = await notes.saveVersion();
		if (error !== null) {
			toast.warning('Version not saved', { description: describeError(error) });
			return;
		}
		toastStatus(commitOutcomeLine(outcome));
	}
</script>

<header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
	<h1 class="text-sm font-semibold">Honeycrisp</h1>

	<StatusPopover
		bind:open
		{summary}
		details={[
			{ name: 'Saves', testid: 'status-saves', line: saves },
			{ name: 'Changes', testid: 'status-changes', line: changes },
			{ name: 'Versions', testid: 'status-history', line: history },
		]}
	>
		<StatusRow name="Recent versions" class="font-mono text-xs" data-testid="status-log">
			{#if typeof log === 'string'}
				<span class="text-destructive">{log}</span>
			{:else}
				{#each log as commit (commit.oid)}
					<span class="block truncate">{commit.oid.slice(0, 7)} {commit.message.split('\n')[0]}</span>
				{:else}
					<span class="font-sans text-muted-foreground">No versions yet</span>
				{/each}
			{/if}
		</StatusRow>
	</StatusPopover>

	<div class="ml-auto flex shrink-0 items-center gap-1">
		<Button
			variant="ghost"
			size="sm"
			tooltip="Record every saved file as a version in Git history"
			disabled={savingVersion || notes.fenced}
			onclick={saveVersion}
		>
			<HistoryIcon />
			Save version
		</Button>
		<LightSwitch variant="ghost" />
		<Button
			variant={filesOpen ? 'secondary' : 'ghost'}
			size="sm"
			tooltip={filesOpen ? 'Hide files (Ctrl+B)' : 'Show files (Ctrl+B)'}
			aria-pressed={filesOpen}
			onclick={onToggleFiles}
		>
			<FolderTreeIcon />
			Files
		</Button>
	</div>
</header>

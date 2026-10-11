<script lang="ts">
	import type { CommitSummary } from '@epicenter/folder';
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import * as Popover from '@epicenter/ui/popover';
	import { toast } from '@epicenter/ui/sonner';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import { getAbortSignal } from 'svelte';
	import type { Notes } from '$lib/notes.svelte.js';
	import {
		draftsLine,
		historyLine,
		savedFilesLine,
		type StatusLine,
		summaryLine,
	} from '$lib/status.js';

	let {
		notes,
		filesOpen,
		terminalOpen,
		onToggleFiles,
		onToggleTerminal,
	}: {
		notes: Notes;
		filesOpen: boolean;
		terminalOpen: boolean;
		onToggleFiles: () => void;
		onToggleTerminal: () => void;
	} = $props();

	const drafts = $derived(
		draftsLine({
			saving: notes.saving,
			notSaved: notes.notSaved,
			unconfirmed: notes.unconfirmed,
			unsettled: notes.unsettled,
		}),
	);
	const files = $derived(savedFilesLine(notes.git));
	const history = $derived(historyLine(notes.git));
	const summary = $derived(summaryLine({ drafts, files, history }));
	const details = $derived<[string, string, StatusLine][]>([
		['Drafts', 'status-drafts', drafts],
		['Saved files', 'status-files', files],
		['Git history', 'status-history', history],
	]);

	const tones: Record<StatusLine['tone'], string> = {
		neutral: 'bg-muted-foreground/50',
		busy: 'bg-primary animate-pulse',
		good: 'bg-success',
		warning: 'bg-warning',
		error: 'bg-destructive',
	};

	let open = $state(false);
	let log = $state.raw<CommitSummary[] | string>([]);

	// Read the recent commits whenever the details open or history moves.
	$effect(() => {
		if (!open) return;
		notes.git.lastCommit;
		const signal = getAbortSignal();
		void notes.host.folder.git.log(8).then(
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

	async function commitNow() {
		const outcome = await notes.commitNow();
		if (outcome.status === 'committed') toast.success(`Committed ${outcome.oid.slice(0, 7)}`);
		else if (outcome.status === 'unchanged') toast.info('Nothing new to commit');
		else if (outcome.status === 'failed') toast.error('Commit failed', { description: outcome.error });
		else if (outcome.status === 'blocked') toast.warning('Commit blocked', { description: outcome.reason });
		else if (outcome.status === 'unconfirmed') toast.warning('Commit reply was lost', { description: `${outcome.error} Check history before committing again.` });
		await notes.check();
	}
</script>

<header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
	<h1 class="text-sm font-semibold">Honeycrisp</h1>

	<Popover.Root bind:open>
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
					<span class="truncate">{summary.label}</span>
					<ChevronDownIcon class="text-muted-foreground" />
				</Button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content align="start" class="w-96 max-w-[calc(100vw-1rem)] p-0">
			<dl class="divide-y text-sm">
				{#each details as [name, testid, line] (name)}
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
				{/each}
				<div class="grid grid-cols-[5.5rem_1fr] gap-x-3 px-3 py-2">
					<dt class="text-xs text-muted-foreground">Recent commits</dt>
					<dd class="min-w-0 font-mono text-xs" data-testid="status-log">
						{#if typeof log === 'string'}
							<span class="text-destructive">{log}</span>
						{:else}
							{#each log as commit (commit.oid)}
								<span class="block truncate">{commit.oid.slice(0, 7)} {commit.message.split('\n')[0]}</span>
							{:else}
								<span class="font-sans text-muted-foreground">No commits yet</span>
							{/each}
						{/if}
					</dd>
				</div>
			</dl>
			<div class="flex items-center gap-2 border-t px-3 py-2">
				<Button variant="outline" size="sm" onclick={() => void notes.check()}>Check again</Button>
				<Button variant="ghost" size="sm" disabled={notes.git.activity.commit.active} onclick={commitNow}>
					Commit saved files
				</Button>
			</div>
		</Popover.Content>
	</Popover.Root>

	<div class="ml-auto flex shrink-0 items-center gap-1">
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
		<Button
			variant={terminalOpen ? 'secondary' : 'ghost'}
			size="sm"
			tooltip={terminalOpen ? 'Hide terminal (Ctrl+`)' : 'Show terminal (Ctrl+`)'}
			aria-pressed={terminalOpen}
			data-terminal-toggle
			onclick={onToggleTerminal}
		>
			<SquareTerminalIcon />
			Terminal
		</Button>
	</div>
</header>

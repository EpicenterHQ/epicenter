<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import ArrowDownToLineIcon from '@lucide/svelte/icons/arrow-down-to-line';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import PanelLeftIcon from '@lucide/svelte/icons/panel-left';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import {
		commitAndPushToast,
		commitLine,
		filesLine,
		pullLine,
		pullOutcomeLine,
		pushLine,
		type StatusLine,
		summaryLine,
		uncommittedLine,
	} from '$lib/status.js';
	import type { Todos } from '$lib/todos.svelte.js';

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
	const uncommitted = $derived(uncommittedLine(todos.git));
	const commit = $derived(commitLine(todos.git));
	const remote = $derived(pushLine(todos.git));
	const pull = $derived(pullLine(todos.git));
	const summary = $derived(summaryLine({ files, uncommitted, commit, remote }));
	const details = $derived<[string, string, StatusLine | undefined][]>([
		['Files', 'status-files', files],
		['Changes', 'status-history', uncommitted],
		['Last commit', 'status-last-commit', commit],
		['Remote', 'status-remote', remote],
		['Last pull', 'status-pull', pull],
	]);

	const tones: Record<StatusLine['tone'], string> = {
		neutral: 'bg-muted-foreground/50',
		busy: 'bg-primary animate-pulse',
		good: 'bg-success',
		warning: 'bg-warning',
		error: 'bg-destructive',
	};

	let working = $state<'commit' | 'pull' | 'fetch' | undefined>();
	const busy = $derived(
		working !== undefined ||
			todos.git.activity.commit.active ||
			todos.git.activity.push.active ||
			todos.git.activity.pull.active,
	);

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
			const fetched = await todos.folder.git.fetch();
			if (fetched.error) toast.error('Fetch failed', { description: fetched.error.message });
			else if (fetched.data.oid === undefined) toast.info('The remote has no commits yet.');
			else toast.success(`Fetched ${fetched.data.oid.slice(0, 7)}.`);
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
				<Button variant="outline" size="sm" onclick={() => void todos.refreshAll()}>Check again</Button>
				<Button
					variant="ghost"
					size="sm"
					disabled={busy}
					tooltip="Download the remote history without changing files"
					onclick={fetchRemote}
				>
					{#if working === 'fetch'}<Spinner class="size-3.5" />{/if}
					Fetch
				</Button>
			</div>
		</Popover.Content>
	</Popover.Root>

	<div class="ml-auto flex shrink-0 items-center gap-1.5">
		<Button
			variant="outline"
			size="sm"
			disabled={busy}
			tooltip="Get commits from the remote. Only a clean fast-forward is applied."
			onclick={pullRemote}
		>
			{#if working === 'pull'}<Spinner class="size-3.5" />{:else}<ArrowDownToLineIcon />{/if}
			<span class="max-sm:sr-only">Pull</span>
		</Button>
		<Button size="sm" disabled={busy} onclick={commitAndPush}>
			{#if working === 'commit'}<Spinner class="size-3.5" />{/if}
			Commit and push
		</Button>
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

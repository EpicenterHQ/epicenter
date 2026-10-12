<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import BugIcon from '@lucide/svelte/icons/bug';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SquareIcon from '@lucide/svelte/icons/square';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import { page } from '$app/state';
	import type { Library } from '$lib/library.svelte.js';
	import RecorderClock from './RecorderClock.svelte';
	import SettingsForm from './SettingsForm.svelte';
	import {
		commitLine,
		commitOutcomeLine,
		filesLineOf,
		headLine,
		type StatusLine,
		summaryLine,
		uncommittedLine,
	} from '$lib/status.js';
	import type { InjectionState } from '$lib/workspace/index.js';

	let {
		library,
		filesOpen,
		terminalOpen,
		onToggleFiles,
		onToggleTerminal,
	}: {
		library: Library;
		filesOpen: boolean;
		terminalOpen: boolean;
		onToggleFiles: () => void;
		onToggleTerminal: () => void;
	} = $props();

	const files = $derived(filesLineOf(library));
	/** The home page has the large recorder; every other page gets this compact one. */
	const onHome = $derived(page.route.id === '/');
	const uncommitted = $derived(uncommittedLine(library.git));
	const commit = $derived(commitLine(library.git));
	const head = $derived(headLine(library.git));
	const summary = $derived(summaryLine({ files, uncommitted, commit }));
	const details = $derived<[string, string, StatusLine][]>([
		['Files', 'status-files', files],
		['Changes', 'status-history', uncommitted],
		['Last version', 'status-last-commit', commit],
		['History', 'status-head', head],
	]);

	const tones: Record<StatusLine['tone'], string> = {
		neutral: 'bg-muted-foreground/50',
		busy: 'bg-primary animate-pulse',
		good: 'bg-success',
		warning: 'bg-warning',
		error: 'bg-destructive',
	};
	const notify: Record<StatusLine['tone'], typeof toast.info> = {
		good: toast.success,
		neutral: toast.info,
		busy: toast.info,
		warning: toast.warning,
		error: toast.error,
	};

	/** Record a version of the saved files: the only thing that commits besides the terminal. */
	let committing = $state(false);
	async function saveVersion() {
		committing = true;
		try {
			const line = commitOutcomeLine(await library.saveVersion());
			notify[line.tone](line.label, { description: line.detail });
		} finally {
			committing = false;
		}
	}

	async function reveal() {
		const problem = await library.workspace.reveal?.();
		if (problem) toast.error('Could not open the folder', { description: problem });
	}

	// Debug controls: injected failures on the desktop.
	let injection = $state<InjectionState | undefined>();
	async function loadInjection() {
		injection = await library.workspace.injection?.state().catch(() => undefined);
	}
	async function arm(change: Partial<InjectionState>) {
		try {
			injection = await library.workspace.injection?.arm(change);
		} catch (cause) {
			toast.error('Could not change the failure', {
				description: cause instanceof Error ? cause.message : String(cause),
			});
		}
	}
</script>

<header class="flex h-12 shrink-0 items-center gap-1.5 border-b px-2 sm:gap-2 sm:px-3">
	{#if library.workspace.capture.source === 'fixture'}
		<Badge variant="outline" class="shrink-0 border-warning text-warning" data-testid="fixture-badge">Fixture<span class="max-sm:sr-only">&nbsp;audio</span></Badge>
	{/if}

	<!-- A live recording is visible and stoppable from every page. -->
	{#if library.recorder.phase === 'recording'}
		<Button variant="destructive" size="sm" class="shrink-0" onclick={() => void library.stopRecording()} data-testid="header-stop-recording">
			<SquareIcon class="fill-current" />
			<span class="max-sm:sr-only">Stop</span>
			<RecorderClock startedAt={library.recorder.startedAt} />
		</Button>
	{:else if library.recorder.phase !== 'idle'}
		<span class="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" role="status">
			<Spinner class="size-3.5" />
			{library.recorder.phase === 'starting' ? 'Starting…' : 'Finishing…'}
		</span>
	{:else if !onHome}
		<Button variant="ghost" size="icon-sm" tooltip="Start recording" aria-label="Start recording" onclick={() => void library.startRecording()} data-testid="header-start-recording">
			<MicIcon />
		</Button>
	{/if}
	{#if library.recorderError && !onHome}
		<span class="min-w-0 truncate text-xs text-destructive" role="alert" title={library.recorderError}>{library.recorderError}</span>
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
					<dt class="text-xs text-muted-foreground">Folder</dt>
					<dd class="min-w-0 font-mono text-xs break-all" data-testid="status-folder">{library.workspace.location}</dd>
				</div>
			</dl>
			<div class="flex items-center gap-2 border-t px-3 py-2">
				<Button variant="outline" size="sm" onclick={() => void library.check()}>Check again</Button>
				<Button size="sm" disabled={committing || library.git.activity.commit.active} onclick={saveVersion} data-testid="save-version">
					{#if committing}<Spinner class="size-3.5" />{/if}
					Save version
				</Button>
			</div>
		</Popover.Content>
	</Popover.Root>

	<div class="ml-auto flex shrink-0 items-center gap-1">
		{#if library.workspace.debugControls}
			<Popover.Root onOpenChange={(open) => open && void loadInjection()}>
				<Popover.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="ghost" size="icon-sm" tooltip="Debug controls" aria-label="Debug controls" data-testid="debug-controls">
							<BugIcon />
						</Button>
					{/snippet}
				</Popover.Trigger>
				<Popover.Content align="end" class="w-96 max-w-[calc(100vw-1rem)] text-sm">
					<p class="mb-2 font-medium">Debug controls</p>
					<p class="mb-3 text-xs text-muted-foreground">Only in a debug build. A release build has none of these.</p>
					<div class="flex flex-col gap-2">
						{#if library.workspace.injection}
							<Button size="sm" variant="outline" onclick={() => void arm({ rowWrites: (injection?.rowWrites ?? 0) + 1 })} data-testid="inject-row">
								Fail the next recording file write (audio lands) · armed {injection?.rowWrites ?? 0}
							</Button>
							<Button size="sm" variant="outline" onclick={() => void arm({ audioWrites: (injection?.audioWrites ?? 0) + 1 })} data-testid="inject-audio">
								Fail the next audio write (nothing lands) · armed {injection?.audioWrites ?? 0}
							</Button>
							<Button
								size="sm"
								variant={injection?.commitsBlocked ? 'secondary' : 'outline'}
								aria-pressed={injection?.commitsBlocked ?? false}
								onclick={() => void arm({ commitsBlocked: !(injection?.commitsBlocked ?? false) })}
								data-testid="inject-commit"
							>
								{injection?.commitsBlocked ? 'Branch is locked: unlock so commits work' : 'Lock the branch so commits fail'}
							</Button>
							<Button size="sm" variant="ghost" onclick={() => void arm({ rowWrites: 0, audioWrites: 0, commitsBlocked: false })}>
								Clear all
							</Button>
						{/if}
					</div>
				</Popover.Content>
			</Popover.Root>
		{/if}

		<Popover.Root>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="icon-sm" tooltip="Connections" aria-label="Settings" data-testid="settings">
						<SettingsIcon />
					</Button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content
				align="end"
				collisionPadding={8}
				class="max-h-(--bits-popover-content-available-height) w-96 max-w-[calc(100vw-1rem)] overflow-y-auto"
			>
				<SettingsForm />
			</Popover.Content>
		</Popover.Root>

		{#if library.workspace.reveal}
			<Button variant="ghost" size="sm" tooltip={library.workspace.location} onclick={reveal} data-testid="reveal-folder">
				<FolderOpenIcon />
				<span class="max-md:sr-only">Reveal folder</span>
			</Button>
		{/if}
		<Button
			variant={filesOpen ? 'secondary' : 'ghost'}
			size="sm"
			tooltip={filesOpen ? 'Hide files (Ctrl+Shift+E)' : 'Show files (Ctrl+Shift+E)'}
			aria-pressed={filesOpen}
			onclick={onToggleFiles}
			data-testid="toggle-files"
		>
			<FolderTreeIcon />
			<span class="max-md:sr-only">Files</span>
		</Button>
		<Button
			variant={terminalOpen ? 'secondary' : 'ghost'}
			size="sm"
			tooltip={terminalOpen ? 'Hide terminal (Ctrl+`)' : 'Show terminal (Ctrl+`)'}
			aria-pressed={terminalOpen}
			data-terminal-toggle
			onclick={onToggleTerminal}
			data-testid="toggle-terminal"
		>
			<SquareTerminalIcon />
			<span class="max-md:sr-only">Terminal</span>
		</Button>
	</div>
</header>

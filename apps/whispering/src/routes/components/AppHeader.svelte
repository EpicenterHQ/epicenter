<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import { Spinner } from '@epicenter/ui/spinner';
	import StatusPopover, { toastStatus } from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { page } from '$app/state';
	import type { Library } from '$lib/library.svelte.js';
	import RecorderClock from './RecorderClock.svelte';
	import SettingsForm from './SettingsForm.svelte';
	import {
		commitLine,
		commitOutcomeLine,
		filesLine,
		headLine,
		summaryLine,
		uncommittedLine,
	} from '$lib/status.js';

	let {
		library,
		filesOpen,
		onToggleFiles,
	}: {
		library: Library;
		filesOpen: boolean;
		onToggleFiles: () => void;
	} = $props();

	const files = $derived(filesLine(library));
	/** The home page has the large recorder; every other page gets this compact one. */
	const onHome = $derived(page.route.id === '/');
	const uncommitted = $derived(uncommittedLine(library.git));
	const commit = $derived(commitLine(library.git));
	const head = $derived(headLine(library.git));
	const summary = $derived(summaryLine({ files, uncommitted, commit }));

	/** Record a version of the saved files: the only thing in Whispering that commits. */
	let committing = $state(false);
	async function saveVersion() {
		committing = true;
		try {
			toastStatus(commitOutcomeLine(await library.saveVersion()));
		} finally {
			committing = false;
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

	<StatusPopover
		{summary}
		details={[
			{ name: 'Files', testid: 'status-files', line: files },
			{ name: 'Changes', testid: 'status-history', line: uncommitted },
			{ name: 'Last version', testid: 'status-last-commit', line: commit },
			{ name: 'History', testid: 'status-head', line: head },
		]}
	>
		<StatusRow name="Folder" class="font-mono text-xs break-all" data-testid="status-folder">{library.workspace.location}</StatusRow>
		{#snippet footer()}
			<Button size="sm" disabled={committing || library.git.activity.commit.active} onclick={saveVersion} data-testid="save-version">
				{#if committing}<Spinner class="size-3.5" />{/if}
				Save version
			</Button>
		{/snippet}
	</StatusPopover>

	<div class="ml-auto flex shrink-0 items-center gap-1">
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
	</div>
</header>

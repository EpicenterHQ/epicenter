<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import { Spinner } from '@epicenter/ui/spinner';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { page } from '$app/state';
	import { getWhispering } from '$lib/whispering.svelte.js';
	import RecorderClock from './RecorderClock.svelte';
	import SettingsForm from './SettingsForm.svelte';
	import { filesLine } from '$lib/status.js';

	let {
		filesOpen,
		onToggleFiles,
	}: {
		filesOpen: boolean;
		onToggleFiles: () => void;
	} = $props();
	const whispering = getWhispering();

	/** Whether what the person did is in the folder on this device. The folder keeps no versions and does not sync here. */
	const files = $derived(
		filesLine({
			saving: whispering.saving,
			unsaved: whispering.unsaved,
			storageFailure: whispering.storageFailure,
			unwrittenAnswers: whispering.unwrittenAnswers,
		}),
	);
	/** The home page has the large recorder; every other page gets this compact one. */
	const onHome = $derived(page.route.id === '/');
</script>

<header class="flex h-12 shrink-0 items-center gap-1.5 border-b px-2 sm:gap-2 sm:px-3">
	{#if whispering.services.capture.source === 'fixture'}
		<Badge variant="outline" class="shrink-0 border-warning text-warning" data-testid="fixture-badge">Fixture<span class="max-sm:sr-only">&nbsp;audio</span></Badge>
	{/if}

	<!-- A live recording is visible and stoppable from every page. -->
	{#if whispering.recorder.phase === 'recording'}
		<Button variant="destructive" size="sm" class="shrink-0" onclick={() => void whispering.stopRecording()} data-testid="header-stop-recording">
			<SquareIcon class="fill-current" />
			<span class="max-sm:sr-only">Stop</span>
			<RecorderClock startedAt={whispering.recorder.startedAt} />
		</Button>
	{:else if whispering.recorder.phase !== 'idle'}
		<span class="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" role="status">
			<Spinner class="size-3.5" />
			{whispering.recorder.phase === 'starting' ? 'Starting…' : 'Finishing…'}
		</span>
	{:else if !onHome}
		<Button variant="ghost" size="icon-sm" tooltip="Start recording" aria-label="Start recording" onclick={() => void whispering.startRecording()} data-testid="header-start-recording">
			<MicIcon />
		</Button>
	{/if}
	{#if whispering.recorderError && !onHome}
		<span class="min-w-0 truncate text-xs text-destructive" role="alert" title={whispering.recorderError}>{whispering.recorderError}</span>
	{/if}

	<StatusPopover summary={files} details={[{ name: 'Files', testid: 'status-files', line: files }]}>
		<StatusRow name="Folder" class="text-xs break-all" data-testid="status-folder">{whispering.services.location}</StatusRow>
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

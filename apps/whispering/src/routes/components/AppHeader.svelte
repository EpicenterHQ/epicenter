<!--
	The header: a live recording, where the recordings are kept (the
	person's repository, or a folder on this computer and its sync, by
	`folder.reveal`), and Settings, where the models and the sign-in are.
	Where there is a global shortcut (`shortcut`), its presses are heard
	here: a press starts a recording, or stops the one under way, from any
	app, as the header's button does.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { IconButton } from '@epicenter/ui/icon-button';
	import * as Popover from '@epicenter/ui/popover';
	import { Spinner } from '@epicenter/ui/spinner';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { folder, shortcut } from '$lib/app.js';
	import FolderChrome from '$lib/components/FolderChrome.svelte';
	import RepositoryChrome from '$lib/components/RepositoryChrome.svelte';
	import { getWhispering } from '$lib/whispering.svelte.js';
	import { pageAt } from './nav-items.js';
	import RecorderClock from './RecorderClock.svelte';
	import SettingsForm from './SettingsForm.svelte';

	const whispering = getWhispering();

	/** The home page has the large recorder; every other page gets this compact one. */
	const onHome = $derived(pageAt(page.url.pathname) === 'home');

	onMount(() =>
		shortcut?.onPress(() => {
			if (whispering.recorder.phase === 'idle') void whispering.startRecording();
			else if (whispering.recorder.phase === 'recording') void whispering.stopRecording();
		}),
	);
</script>

<header class="flex h-12 shrink-0 items-center gap-1.5 border-b px-2 sm:gap-2 sm:px-3">
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
			{whispering.recorder.phase === 'starting' ? 'Starting…' : 'Stopping…'}
		</span>
	{:else if !onHome}
		<IconButton label="Start recording" size="sm" variant="ghost" onclick={() => void whispering.startRecording()} data-testid="header-start-recording">
			<MicIcon />
		</IconButton>
	{/if}
	{#if whispering.recorderError && !onHome}
		<span class="min-w-0 truncate text-xs text-destructive" role="alert" title={whispering.recorderError}>{whispering.recorderError}</span>
	{/if}

	{#if folder.reveal === null}<RepositoryChrome />{:else}<FolderChrome />{/if}

	<div class="ml-auto flex shrink-0 items-center gap-1">
		<Popover.Root>
			<Popover.Trigger>
				{#snippet child({ props })}
					<IconButton label="Models and sign-in" size="sm" {...props} variant="ghost" data-testid="settings">
						<SettingsIcon />
					</IconButton>
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
	</div>
</header>

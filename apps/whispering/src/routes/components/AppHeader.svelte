<!--
	The header: a live recording, the two views (decision 76), "On this
	device" and "Synced", what the open one shows, and Settings, where the
	account is.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import { Spinner } from '@epicenter/ui/spinner';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { page } from '$app/state';
	import { getAuth } from '#platform/auth';
	import { getLibrary } from '$lib/library.svelte.js';
	import { headerStatus } from '$lib/status.js';
	import { getWhispering } from '$lib/whispering.svelte.js';
	import { pageAt, pathOf } from './nav-items.js';
	import RecorderClock from './RecorderClock.svelte';
	import SettingsForm from './SettingsForm.svelte';

	const whispering = getWhispering();
	const library = getLibrary();
	const auth = getAuth();

	/** The page open now, which a view link keeps in the other view. */
	const current = $derived(pageAt(page.url.pathname));
	/** What the open view shows: this browser's files, or the repository and whether it can be reached. */
	const status = $derived(
		headerStatus({
			view: library.view,
			unwrittenAnswers: library.unwrittenAnswers,
			auth: auth.state.status,
			problem: library.error?.message,
		}),
	);
	/** The home page has the large recorder; every other page gets this compact one. */
	const onHome = $derived(current === 'home');
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

	<nav class="flex shrink-0 items-center gap-1" aria-label="Views">
		<Button
			size="sm"
			variant={library.view === 'device' ? 'secondary' : 'ghost'}
			href={pathOf('device', current)}
			aria-current={library.view === 'device' ? 'page' : undefined}
		>
			On this device
		</Button>
		<Button
			size="sm"
			variant={library.view === 'synced' ? 'secondary' : 'ghost'}
			href={pathOf('synced', current)}
			aria-current={library.view === 'synced' ? 'page' : undefined}
		>
			Synced
		</Button>
	</nav>

	<StatusPopover summary={status} details={[{ name: 'Files', testid: 'status-files', line: status }]}>
		<StatusRow name="Kept in" class="text-xs break-all" data-testid="status-folder">
			{library.view === 'device' ? 'This browser’s storage for this site' : 'Your whispering repository'}
		</StatusRow>
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
	</div>
</header>

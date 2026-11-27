<!--
	Whispering's places, one level deep: Home and Recordings, then each
	settings section by name, so no setting sits behind a second menu. The
	footer says whether dictation is ready, and how many things it still
	needs, which Home lists.
-->
<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import HouseIcon from '@lucide/svelte/icons/house';
	import KeyboardIcon from '@lucide/svelte/icons/keyboard';
	import ListIcon from '@lucide/svelte/icons/list';
	import MicIcon from '@lucide/svelte/icons/mic';
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import ClipboardIcon from '@lucide/svelte/icons/clipboard';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import { page } from '$app/state';
	import studioMicrophone from '#lib/assets/studio-microphone.png';
	import { getDictation } from '#lib/dictation-view.ts';

	const dictation = getDictation();

	const PLACES = [
		{ label: 'Home', href: '/', icon: HouseIcon },
		{ label: 'Recordings', href: '/recordings', icon: ListIcon },
	];
	const SETTINGS = [
		{ label: 'Shortcuts', href: '/settings/shortcuts', icon: KeyboardIcon },
		{ label: 'Microphone', href: '/settings/microphone', icon: MicIcon },
		{ label: 'Transcription', href: '/settings/transcription', icon: AudioLinesIcon },
		{ label: 'Clean up', href: '/settings/cleanup', icon: SparklesIcon },
		{ label: 'Output', href: '/settings/output', icon: ClipboardIcon },
		{ label: 'Storage', href: '/settings/storage', icon: HardDriveIcon },
	];

	const unmet = $derived(dictation.needs().length);
</script>

{#snippet places(items: typeof PLACES, label: string)}
	<Sidebar.Menu aria-label={label}>
		{#each items as item (item.href)}
			{@const active =
				item.href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(item.href)}
			<Sidebar.MenuItem>
				<Sidebar.MenuButton isActive={active} tooltipContent={item.label}>
					{#snippet child({ props })}
						<a href={item.href} aria-current={active ? 'page' : undefined} {...props}>
							<item.icon />
							<span>{item.label}</span>
						</a>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		{/each}
	</Sidebar.Menu>
{/snippet}

<Sidebar.Root collapsible="icon">
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton size="lg" tooltipContent="Whispering">
					{#snippet child({ props })}
						<a href="/" {...props}>
							<span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent">
								<img src={studioMicrophone} alt="" class="size-5" />
							</span>
							<span class="truncate font-semibold">Whispering</span>
						</a>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupContent>{@render places(PLACES, 'Pages')}</Sidebar.GroupContent>
		</Sidebar.Group>
		<Sidebar.Group>
			<Sidebar.GroupLabel>Settings</Sidebar.GroupLabel>
			<Sidebar.GroupContent>{@render places(SETTINGS, 'Settings')}</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>

	<Sidebar.Footer>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton tooltipContent={unmet ? `${unmet} to fix` : 'Ready'}>
					{#snippet child({ props })}
						<a href="/" {...props}>
							{#if unmet}
								<CircleAlertIcon class="text-destructive" />
								<span>{unmet} to fix</span>
							{:else}
								<CircleCheckIcon class="text-muted-foreground" />
								<span class="text-muted-foreground">Ready</span>
							{/if}
						</a>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Footer>

	<Sidebar.Rail />
</Sidebar.Root>

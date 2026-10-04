<script lang="ts">
	import * as Command from '@epicenter/ui/command';
	import { cn } from '@epicenter/ui/utils';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CloudIcon from '@lucide/svelte/icons/cloud';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import ServerIcon from '@lucide/svelte/icons/server';
	import type { SwitcherLeaf } from '$lib/settings/transcription-switcher';

	let {
		leaf,
		onSelect,
	}: {
		leaf: SwitcherLeaf;
		/** Runs after `leaf.select()`; the popover uses it to close and refocus. */
		onSelect: () => void;
	} = $props();

	// The where-it-runs glyph, secondary to the brand icon. session and key both
	// run over the network (distinct brand icons already tell them apart); the
	// glyph answers "does my audio leave this device?" at a glance.
	const ACCESS_META = {
		onDevice: { Icon: HardDriveIcon, label: 'On device' },
		session: { Icon: CloudIcon, label: 'Hosted' },
		key: { Icon: CloudIcon, label: 'Cloud' },
		endpoint: { Icon: ServerIcon, label: 'Server' },
	} as const;

	const access = $derived(ACCESS_META[leaf.access]);
</script>

<Command.Item
	value={leaf.keywords}
	onSelect={() => {
		leaf.select();
		onSelect();
	}}
	class="flex items-center gap-2 px-2 py-2"
>
	<CheckIcon
		class={cn('size-3.5 shrink-0', !leaf.isActive && 'text-transparent')}
	/>
	<div
		class={cn(
			'size-4 shrink-0 flex items-center justify-center [&>svg]:size-full',
			leaf.invertInDarkMode && 'dark:[&>svg]:invert dark:[&>svg]:brightness-90',
		)}
	>
		{@html leaf.icon}
	</div>
	<div class="flex-1 min-w-0">
		<div class="font-medium text-sm truncate">{leaf.title}</div>
		<!-- The exact-model confirmation (#2337): which model this route will run,
		and for a custom server, which host runs it. One truncating line; the full
		values live in settings and stay searchable via `leaf.keywords`. -->
		{#if leaf.modelId}
			<div class="text-xs text-muted-foreground truncate">
				{#if leaf.endpointHost}
					{leaf.modelId} · {leaf.endpointHost}
				{:else}
					{leaf.modelId}
				{/if}
			</div>
		{/if}
	</div>
	<div class="flex items-center gap-1 shrink-0 text-muted-foreground">
		<access.Icon class="size-3" />
		<span class="text-[10px] uppercase tracking-wide">{access.label}</span>
	</div>
</Command.Item>

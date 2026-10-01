<script lang="ts">
	import * as Command from '@epicenter/ui/command';
	import { cn } from '@epicenter/ui/utils';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CloudIcon from '@lucide/svelte/icons/cloud';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import ServerIcon from '@lucide/svelte/icons/server';
	import type { Transcriber } from '$lib/settings/transcription-switcher';

	let {
		transcriber,
		onSelect,
	}: {
		transcriber: Transcriber;
		/** Runs after `transcriber.select()`; the popover uses it to close and refocus. */
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

	const access = $derived(ACCESS_META[transcriber.access]);
</script>

<Command.Item
	value={transcriber.keywords}
	onSelect={() => {
		transcriber.select();
		onSelect();
	}}
	class="flex items-center gap-2 px-2 py-2"
>
	<CheckIcon
		class={cn('size-3.5 shrink-0', !transcriber.isActive && 'text-transparent')}
	/>
	<div
		class={cn(
			'size-4 shrink-0 flex items-center justify-center [&>svg]:size-full',
			transcriber.invertInDarkMode &&
				'dark:[&>svg]:invert dark:[&>svg]:brightness-90',
		)}
	>
		{@html transcriber.icon}
	</div>
	<div class="flex-1 min-w-0">
		<div class="font-medium text-sm truncate">{transcriber.title}</div>
		<!-- Self-hosted / keyed routes surface the selected model id (#2337). -->
		{#if transcriber.modelId}
			<div class="text-xs text-muted-foreground truncate">
				{#if transcriber.endpointHost}
					{transcriber.endpointHost} · {transcriber.modelId}
				{:else}
					{transcriber.modelId}
				{/if}
			</div>
		{/if}
	</div>
	<div class="flex items-center gap-1 shrink-0 text-muted-foreground">
		<access.Icon class="size-3" />
		<span class="text-[10px] uppercase tracking-wide">{access.label}</span>
	</div>
</Command.Item>

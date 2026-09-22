<script lang="ts">
	import { local } from '$lib/whispering/local.js';
	import { DEVICE_DEFAULTS } from '$lib/operations/settings.js';
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import OutputDeliveryControls from '$lib/components/OutputDeliveryControls.svelte';
	import { SettingSwitch } from '$lib/components/settings';
	import { captureSurface } from '$lib/state/capture-surface.svelte';

	let open = $state(false);

	const pausePlaybackDescription = $derived.by(() => {
		switch (captureSurface.current()) {
			case 'vad':
				return 'Pause music or video while you are speaking, then try to resume shortly after you stop.';
			case 'manual':
			case 'import':
				return 'Pause music or video while you are recording, then try to resume when you stop.';
		}
	});
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				tooltip="Quick settings"
				aria-label="Quick settings"
				aria-expanded={open}
				variant="ghost"
				size="icon"
			>
				<SlidersHorizontalIcon class="size-4" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80">
		<div class="flex flex-col gap-3">
			<SettingSwitch
				checked={local.kv.get('recordingPausePlayback') ??
					DEVICE_DEFAULTS.recordingPausePlayback}
				onCheckedChange={(checked) =>
					local.kv.update({ recordingPausePlayback: checked })}
				label="Pause playback while recording"
				description={pausePlaybackDescription}
			/>
			<OutputDeliveryControls scope="transcription" />
		</div>
	</Popover.Content>
</Popover.Root>

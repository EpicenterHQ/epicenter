<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Command from '@epicenter/ui/command';
	import { useCombobox } from '@epicenter/ui/hooks';
	import * as Popover from '@epicenter/ui/popover';
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';
	import CheckIcon from '@lucide/svelte/icons/check';
	import MicIcon from '@lucide/svelte/icons/mic';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { createQuery } from '@tanstack/svelte-query';
	import { report } from '$lib/report';
	import { tauri } from '#platform/tauri';
	import { manualRecorderConfig } from '#platform/manual-recorder-config';
		import { getWhisperingApp } from '$lib/whispering/context';
	const app = getWhisperingApp();

	let {
		iconViewTransitionName,
	}: {
		/** When set, names the mic glyph for a cross-page view transition. */
		iconViewTransitionName?: string;
	} = $props();

	const combobox = useCombobox();

	const getDevicesQuery = createQuery(() => ({
		...app.recording.enumerateDevices(),
		enabled: combobox.open,
	}));

	$effect(() => {
		if (getDevicesQuery.isError) {
			report.info({ cause: getDevicesQuery.error });
		}
	});

	async function requestMicrophoneAccess() {
		if (!tauri) return;
		const { error } = await tauri.permissions.microphone.request();
		if (error) {
			report.error({ cause: error });
			return;
		}
		await getDevicesQuery.refetch();
	}
</script>

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			<Button
				{...props}
				tooltip={manualRecorderConfig.deviceId
					? 'Change microphone'
					: 'Choose microphone'}
				role="combobox"
				aria-expanded={combobox.open}
				variant="ghost"
				size="icon"
			>
				<span
					class="inline-flex shrink-0"
					style:view-transition-name={iconViewTransitionName}
				>
					{#if manualRecorderConfig.deviceId}
						<MicIcon class="size-4 text-green-500" />
					{:else}
						<MicIcon class="size-4 text-warning" />
					{/if}
				</span>
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="p-0">
		<Command.Root loop>
			<Command.Input placeholder="Search devices..." />
			<Command.List class="max-h-[40vh]">
				<Command.Empty>No recording devices found.</Command.Empty>

				<Command.Group heading="Recording Device">
					{#if getDevicesQuery.isPending}
						<div class="p-4 text-center text-sm text-muted-foreground">
							Loading devices...
						</div>
					{:else if getDevicesQuery.isError}
						<div class="space-y-3 p-4 text-center">
							<p class="text-sm text-destructive">
								{getDevicesQuery.error.message}
							</p>
							{#if tauri}
								<Button
									variant="outline"
									size="sm"
									onclick={requestMicrophoneAccess}
								>
									Grant microphone access
								</Button>
							{/if}
						</div>
					{:else}
						{#each getDevicesQuery.data as device (device.id)}
							<Command.Item
								value="device-{device.id} {device.label}"
								onSelect={() => {
									manualRecorderConfig.deviceId =
										manualRecorderConfig.deviceId === device.id
											? null
											: device.id;
								}}
								class="flex items-center gap-3 px-3 py-2"
							>
								<CheckIcon
									class={cn(
										'size-4 shrink-0',
										manualRecorderConfig.deviceId === device.id
											? 'opacity-100'
											: 'opacity-0',
									)}
								/>
								<span class="flex-1 text-sm">{device.label}</span>
							</Command.Item>
						{/each}
					{/if}
				</Command.Group>
				<Command.Separator />
				<Command.Group>
					<Command.Item
						onSelect={() => {
							getDevicesQuery.refetch();
						}}
					>
						{#if getDevicesQuery.isRefetching}
							<Spinner />
						{:else}
							<RefreshCwIcon class="size-4" />
						{/if}
						Refresh devices
					</Command.Item>
				</Command.Group>
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>

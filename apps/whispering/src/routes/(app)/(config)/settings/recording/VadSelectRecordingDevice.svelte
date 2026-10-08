<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import * as Select from '@epicenter/ui/select';
	import { Spinner } from '@epicenter/ui/spinner';
	import { createQuery } from '@tanstack/svelte-query';
	import { report } from '$lib/report';
	import type { DeviceIdentifier } from '@epicenter/recorder';
	import { asDeviceIdentifier } from '@epicenter/recorder';
	import { vadRecorder } from '$lib/state/vad-recorder.svelte';

	let {
		selected = $bindable(),
	}: {
		selected: DeviceIdentifier | null;
	} = $props();

	// Use vadRecorder.enumerateDevices for VAD (navigator devices only)
	const getDevicesQuery = createQuery(
		() => vadRecorder.enumerateDevices.options,
	);

	$effect(() => {
		if (getDevicesQuery.isError) {
			report.info({ cause: getDevicesQuery.error });
		}
	});

	const items = $derived(
		getDevicesQuery.data?.map((device) => ({
			value: device.id,
			label: device.label,
		})) ?? [],
	);

	const selectedLabel = $derived(
		items.find((item) => item.value === selected)?.label,
	);
</script>

{#if getDevicesQuery.isPending}
	<Field.Field>
		<Field.Label for="vad-recording-device">VAD Recording Device</Field.Label>
		<Select.Root type="single" disabled>
			<Select.Trigger id="vad-recording-device" class="w-full">
				<span class="flex items-center gap-2 text-muted-foreground">
					<Spinner class="size-3.5" />
					Loading devices
				</span>
			</Select.Trigger>
		</Select.Root>
	</Field.Field>
{:else if getDevicesQuery.isError}
	<p class="text-sm text-red-500">{getDevicesQuery.error.message}</p>
{:else}
	<Field.Field>
		<Field.Label for="vad-recording-device">VAD Recording Device</Field.Label>
		<Select.Root
			type="single"
			bind:value={() => selected ?? asDeviceIdentifier(''),
				(value) => (selected = value ? asDeviceIdentifier(value) : null)}
		>
			<Select.Trigger id="vad-recording-device" class="w-full">
				{selectedLabel ?? 'Select a device'}
			</Select.Trigger>
			<Select.Content>
				<Select.Group>
					{#each items as item}
						<Select.Item value={item.value} label={item.label} />
					{/each}
				</Select.Group>
			</Select.Content>
		</Select.Root>
	</Field.Field>
{/if}

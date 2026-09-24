<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import * as Select from '@epicenter/ui/select';
	import { Spinner } from '@epicenter/ui/spinner';
	import { createQuery } from '@tanstack/svelte-query';
	import { report } from '$lib/report';
	import type { DeviceIdentifier } from '@epicenter/recorder';
	import { asDeviceIdentifier } from '@epicenter/recorder';
		import { getWhisperingApp } from '$lib/whispering/context';
	const app = getWhisperingApp();
	import { tauri } from '#platform/tauri';

	let {
		selected = $bindable(),
	}: {
		selected: DeviceIdentifier | null;
	} = $props();

	// Use app.recording.enumerateDevices for manual recording (includes desktop devices)
	const getDevicesQuery = createQuery(
		() => app.recording.enumerateDevices(),
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

{#if getDevicesQuery.isPending}
	<Field.Field>
		<Field.Label for="manual-recording-device">Recording Device</Field.Label>
		<Select.Root type="single" disabled>
			<Select.Trigger id="manual-recording-device" class="w-full">
				<span class="flex items-center gap-2 text-muted-foreground">
					<Spinner class="size-3.5" />
					Loading devices
				</span>
			</Select.Trigger>
		</Select.Root>
	</Field.Field>
{:else if getDevicesQuery.isError}
	<Field.Field>
		<Field.Label for="manual-recording-device">Recording Device</Field.Label>
		<div class="space-y-3">
			<p class="text-sm text-red-500">{getDevicesQuery.error.message}</p>
			{#if tauri}
				<Button variant="outline" size="sm" onclick={requestMicrophoneAccess}>
					Grant microphone access
				</Button>
			{/if}
		</div>
	</Field.Field>
{:else}
	<Field.Field>
		<Field.Label for="manual-recording-device">Recording Device</Field.Label>
		<Select.Root
			type="single"
			bind:value={() => selected ?? asDeviceIdentifier(''),
				(value) => (selected = value ? asDeviceIdentifier(value) : null)}
		>
			<Select.Trigger id="manual-recording-device" class="w-full">
				{selectedLabel ?? 'Select a device'}
			</Select.Trigger>
			<Select.Content>
				{#each items as item}
					<Select.Item value={item.value} label={item.label} />
				{/each}
			</Select.Content>
		</Select.Root>
	</Field.Field>
{/if}

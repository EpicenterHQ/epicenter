<script lang="ts">
	import { local } from '$lib/whispering/local.js';
	import { DEVICE_DEFAULTS } from '$lib/operations/settings.js';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { Separator } from '@epicenter/ui/separator';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { report } from '$lib/report';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import SidebarNav from './SidebarNav.svelte';

	let { children } = $props();
</script>

<main class="flex w-full flex-1 flex-col pb-4 pt-2 px-4 mx-auto max-w-6xl">
	<div
		class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
	>
		<SectionHeader.Root class="space-y-0.5">
			<SectionHeader.Title level={2} class="text-2xl font-bold tracking-tight"
				>Settings</SectionHeader.Title
			>
			<SectionHeader.Description>
				Customize your Whispering experience.
			</SectionHeader.Description>
		</SectionHeader.Root>
		<Button
			variant="outline"
			size="sm"
			onclick={() => {
				confirmationDialog.open({
					title: 'Reset device settings',
					description:
						'This resets settings on this device, including shortcuts, sounds, and processing choices.',
					confirm: { text: 'Reset Settings', variant: 'destructive' },
					onConfirm: () => {
						local.kv.update(DEVICE_DEFAULTS);
						deviceConfig.reset();
						report.success({
							title: 'Settings reset',
							description: 'Device settings have been reset to defaults.',
						});
					},
				});
			}}
			class="shrink-0"
		>
			<RotateCcw class="size-4" />
			Reset to defaults
		</Button>
	</div>
	<Separator class="my-6" />
	<div class="flex flex-col space-y-8 lg:flex-row lg:gap-8">
		<aside class="lg:w-1/6"><SidebarNav /></aside>
		<main class="flex-1 p-1.5 lg:max-w-3xl">{@render children()}</main>
	</div>
</main>

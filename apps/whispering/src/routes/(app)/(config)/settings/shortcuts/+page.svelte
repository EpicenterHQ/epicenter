<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { Separator } from '@epicenter/ui/separator';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { report } from '$lib/report';
	import { createAppShortcuts } from '$lib/shortcuts';
	import { getWhisperingApp } from '$lib/whispering/context';
	import KeyboardShortcutRecorder from './keyboard-shortcut-recorder/KeyboardShortcutRecorder.svelte';
	import ShortcutTable from './keyboard-shortcut-recorder/ShortcutTable.svelte';

	// One flat list, no platform branch (ADR-0052): every command gets one
	// router-driven recorder. The reach of the key the user presses, not a scope
	// tab, decides whether a binding lands in the synced focused store or the
	// per-device global store. Reset restores both stores to their defaults.
	function reset() {
		createAppShortcuts(getWhisperingApp()).reset();
		report.success({
			title: 'Shortcuts reset',
			description: 'All shortcuts have been reset to defaults.',
		});
	}
</script>

<svelte:head> <title>Keyboard Shortcuts - Whispering</title> </svelte:head>

<section class="mx-auto max-w-4xl py-6">
	<div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
		<SectionHeader.Root>
			<SectionHeader.Title level={1} class="text-3xl">
				Keyboard Shortcuts
			</SectionHeader.Title>
			<SectionHeader.Description class="mt-2">
				Set a shortcut for any command, in Whispering or everywhere.
			</SectionHeader.Description>
		</SectionHeader.Root>
		<Button variant="outline" size="sm" onclick={reset} class="shrink-0">
			<RotateCcw class="size-4" />
			Reset shortcuts
		</Button>
	</div>

	<Separator class="my-6" />

	<ShortcutTable>
		{#snippet row(command)}
			<KeyboardShortcutRecorder {command} />
		{/snippet}
	</ShortcutTable>
</section>

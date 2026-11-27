<!--
	The list of microphones to record from, on Home and in Settings. A choice
	is saved the moment it is made and used from the next recording on. The
	list asks which microphones are connected each time it opens, so one
	plugged in a moment ago is there.

	`compact` is Home's form: a quiet line under the recorder that names the
	microphone, so switching takes one click and never a trip to Settings.
-->
<script lang="ts">
	import * as Select from '@epicenter/ui/select';
	import { toastOnError } from '@epicenter/ui/toast-on-error';
	import { cn } from '@epicenter/ui/utils';
	import MicIcon from '@lucide/svelte/icons/mic';
	import type { Input } from '#lib/platform/recorder/recorder.ts';
	import { createQuery } from '@tanstack/svelte-query';
	import { runMutation } from 'wellcrafted/query';
	import {
		microphonesQueries,
		queryClient,
		settingsMutations,
		settingsQueries,
	} from '#lib/queries.ts';

	let {
		id,
		compact = false,
		disabled = false,
	}: { id?: string; compact?: boolean; disabled?: boolean } = $props();

	/** The value the list gives the system default; a microphone's own id never looks like it. */
	const DEFAULT = '';

	const connected = createQuery(() => microphonesQueries.list());
	const inputs = $derived<Input[]>(connected.data ?? []);
	const settings = createQuery(() => settingsQueries.read());
	const chosen = $derived(settings.data?.microphone ?? DEFAULT);
	const systemDefault = $derived(inputs.find((input) => input.isDefault));
	const defaultLabel = $derived(`System default${systemDefault ? ` (${systemDefault.name})` : ''}`);
	const label = $derived.by(() => {
		if (chosen !== DEFAULT) {
			return inputs.find((input) => input.id === chosen)?.name ?? 'A microphone that is not connected';
		}
		if (compact) return systemDefault?.name ?? 'System default microphone';
		return defaultLabel;
	});

	async function choose(value: string) {
		const saved = await runMutation(queryClient, settingsMutations.update, {
			microphone: value === DEFAULT ? undefined : value,
		});
		toastOnError(saved, 'Could not save the microphone');
	}
</script>

<Select.Root
	type="single"
	value={chosen}
	{disabled}
	onValueChange={(value) => void choose(value)}
	onOpenChange={(open) => {
		if (open) void connected.refetch();
	}}
>
	<Select.Trigger
		{id}
		aria-label={compact ? 'Microphone' : undefined}
		class={cn(
			compact
				? 'h-8 max-w-72 border-none bg-transparent text-muted-foreground shadow-none hover:text-foreground dark:bg-transparent dark:hover:bg-transparent'
				: 'w-full',
		)}
	>
		{#if compact}<MicIcon class="size-4" />{/if}
		<span class="truncate">{label}</span>
	</Select.Trigger>
	<Select.Content>
		<Select.Item value={DEFAULT}>{defaultLabel}</Select.Item>
		{#each inputs as input (input.id)}
			<Select.Item value={input.id}>{input.name}</Select.Item>
		{/each}
	</Select.Content>
</Select.Root>

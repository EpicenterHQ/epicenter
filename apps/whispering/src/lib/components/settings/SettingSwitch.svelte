<script lang="ts">
	import { getSetting } from '$lib/operations/settings.js';
	import * as Field from '@epicenter/ui/field';
	import { Switch } from '@epicenter/ui/switch';
	import type { BooleanSettingKey } from '$lib/operations/settings.js';
	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();

	let {
		key,
		label,
		description,
		onCheckedChange,
	}: {
		key: BooleanSettingKey;
		label: string;
		description?: string;
		/** Runs after the setting is written, e.g. to log the change. */
		onCheckedChange?: (checked: boolean) => void;
	} = $props();

	// Opaque, generated id wired into both `for` and `id` from one source. The
	// id has no external consumer, so it carries no meaning by design: there is
	// nothing to keep in sync with the setting key, and nothing to drift.
	const id = $props.id();
</script>

<Field.Field orientation="horizontal">
	<Field.Content>
		<Field.Label for={id}>{label}</Field.Label>
		{#if description}
			<Field.Description>{description}</Field.Description>
		{/if}
	</Field.Content>
	<Switch
		{id}
		bind:checked={
			() => getSetting(app.device.kv, key),
			(checked) => {
				app.device.kv.update({ [key]: checked });
				onCheckedChange?.(checked);
			}
		}
	/>
</Field.Field>

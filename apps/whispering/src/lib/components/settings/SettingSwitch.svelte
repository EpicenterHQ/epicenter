<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { Switch } from '@epicenter/ui/switch';

	let {
		checked,
		label,
		description,
		onCheckedChange,
	}: {
		checked: boolean;
		label: string;
		description?: string;
		onCheckedChange: (checked: boolean) => void;
	} = $props();

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
		{checked}
		{onCheckedChange}
	/>
</Field.Field>

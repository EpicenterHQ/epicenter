<script lang="ts" generics="V extends string | number">
	import * as Field from '@epicenter/ui/field';
	import * as Select from '@epicenter/ui/select';

	let {
		value,
		onSelect,
		label,
		items,
		description,
	}: {
		value: NoInfer<V>;
		onSelect: (value: NoInfer<V>) => void;
		label: string;
		items: readonly { value: V; label: string }[];
		description?: string;
	} = $props();

	// Opaque, generated id wired into both `for` and the trigger from one source.
	const id = $props.id();

	const selectedLabel = $derived(
		items.find((item) => item.value === value)?.label,
	);
</script>

<Field.Field>
	<Field.Label for={id}>{label}</Field.Label>
	<Select.Root
		type="single"
		bind:value={
			() => String(value),
			(value) => {
				// bits-ui Select is string-valued; the items list is the source of
				// truth for mapping the string form back to the typed value.
				const match = items.find((item) => String(item.value) === value);
				if (match) onSelect(match.value);
			}
		}
	>
		<Select.Trigger {id} class="w-full">
			{selectedLabel ?? 'Select an option'}
		</Select.Trigger>
		<Select.Content>
			{#each items as item}
				<Select.Item value={String(item.value)} label={item.label} />
			{/each}
		</Select.Content>
	</Select.Root>
	{#if description}
		<Field.Description>{description}</Field.Description>
	{/if}
</Field.Field>

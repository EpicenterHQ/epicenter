<script lang="ts" generics="V extends string | number, K extends string">
	import * as Field from '@epicenter/ui/field';
	import * as Select from '@epicenter/ui/select';

	// Drives one typed dropdown over whatever store is passed: the synced
	// workspace `settings` or the device-local `deviceConfig`. Both expose the
	// same `get(key)`/`set(key, value)` shape, so one component covers both. The
	// store is an explicit prop, not a default, so each call site states where
	// its value lives.
	let {
		store,
		key,
		label,
		items,
		description,
	}: {
		// `NoInfer` keeps the store from driving inference: `K` comes from `key`
		// and `V` from `items`, and the store is only checked against them. Without
		// it, the store's full key union and value union (which includes `null` and
		// `boolean` keys) pollute `K`/`V` and the component stops type-checking.
		store: {
			get(key: NoInfer<K>): NoInfer<V>;
			set(key: NoInfer<K>, value: NoInfer<V>): void;
		};
		key: K;
		label: string;
		items: readonly { value: V; label: string }[];
		description?: string;
	} = $props();

	// Opaque, generated id wired into both `for` and the trigger from one source.
	const id = $props.id();

	const selectedLabel = $derived(
		items.find((item) => item.value === store.get(key))?.label,
	);
</script>

<Field.Field>
	<Field.Label for={id}>{label}</Field.Label>
	<Select.Root
		type="single"
		bind:value={
			() => String(store.get(key)),
			(value) => {
				// bits-ui Select is string-valued; the items list is the source of
				// truth for mapping the string form back to the typed value.
				const match = items.find((item) => String(item.value) === value);
				if (match) store.set(key, match.value);
			}
		}
	>
		<Select.Trigger {id} class="w-full">
			{selectedLabel ?? 'Select an option'}
		</Select.Trigger>
		<Select.Content>
			<Select.Group>
				{#each items as item}
					<Select.Item value={String(item.value)} label={item.label} />
				{/each}
			</Select.Group>
		</Select.Content>
	</Select.Root>
	{#if description}
		<Field.Description>{description}</Field.Description>
	{/if}
</Field.Field>

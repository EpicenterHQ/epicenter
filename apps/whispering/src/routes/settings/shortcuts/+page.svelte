<!--
	Settings · Shortcuts. The keys that record from any app. Two are always
	on: one starts and stops a take, one records while held. A third turns
	Hands-free on and off. Only the first is built; it is fixed for now.
-->
<script lang="ts">
	import * as Field from '@epicenter/ui/field';
</script>

<svelte:head><title>Shortcuts · Whispering</title></svelte:head>

<Field.Set>
	<Field.Legend>Shortcuts</Field.Legend>
	<Field.Description>These work from any app, while Whispering is open.</Field.Description>
	<Field.Group>
		{#each [
			{ label: 'Start and stop', key: '⌘⇧;', note: 'Works now. Changing it is not built yet.' },
			{ label: 'Hold to talk', key: '⌥Space', note: 'Records while the keys are held. Not built yet.' },
			{ label: 'Hands-free on or off', key: 'None', note: 'Not built yet.' },
		] as row (row.label)}
			<Field.Field orientation="horizontal">
				<Field.Content>
					<Field.Label>{row.label}</Field.Label>
					<Field.Description>{row.note}</Field.Description>
				</Field.Content>
				<kbd class="rounded-md border px-2 py-1 font-sans text-sm">{row.key}</kbd>
			</Field.Field>
		{/each}
	</Field.Group>
</Field.Set>

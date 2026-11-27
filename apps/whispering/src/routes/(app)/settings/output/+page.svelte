<!--
	Settings · Output. Where a finished take's text goes, and what Whispering
	does around a take. The clipboard is the default because it needs no
	permission; paste at the cursor needs macOS's Accessibility permission,
	and a paste that cannot land leaves the text on the clipboard. Media
	pause is off by default: macOS can resume something the person had paused.
	Only the clipboard is built; the rest shows the target.
-->
<script lang="ts">
	import { Checkbox } from '@epicenter/ui/checkbox';
	import * as Field from '@epicenter/ui/field';
	import * as RadioGroup from '@epicenter/ui/radio-group';
</script>

<svelte:head><title>Output · Whispering</title></svelte:head>

<Field.Set>
	<Field.Legend>When a take is ready</Field.Legend>
	<RadioGroup.Root value="clipboard">
		<Field.Field orientation="horizontal">
			<RadioGroup.Item value="clipboard" id="to-clipboard" />
			<Field.Label for="to-clipboard">Copy it to the clipboard</Field.Label>
		</Field.Field>
		<Field.Field orientation="horizontal" data-disabled>
			<RadioGroup.Item value="cursor" id="to-cursor" disabled />
			<Field.Content>
				<Field.Label for="to-cursor">Paste it where I am typing</Field.Label>
				<Field.Description>
					Needs macOS's Accessibility permission. If a paste cannot land, the text stays on the
					clipboard. Not built yet.
				</Field.Description>
			</Field.Content>
		</Field.Field>
	</RadioGroup.Root>
</Field.Set>

<Field.Set>
	<Field.Legend>While recording</Field.Legend>
	<Field.Group>
		{#each [
			{ id: 'pause-media', label: 'Pause music and video', note: 'May resume something you had paused yourself. Not built yet.' },
			{ id: 'pill', label: 'Show the floating pill over other apps', note: 'Not built yet.' },
			{ id: 'sounds', label: 'Play start and stop sounds', note: 'Not built yet.' },
		] as row (row.id)}
			<Field.Field orientation="horizontal" data-disabled>
				<Checkbox id={row.id} disabled />
				<Field.Content>
					<Field.Label for={row.id}>{row.label}</Field.Label>
					<Field.Description>{row.note}</Field.Description>
				</Field.Content>
			</Field.Field>
		{/each}
	</Field.Group>
</Field.Set>

<!--
	Settings · Output. Where a finished take's text goes, and what Whispering
	does around a take. The clipboard is the default because it needs no
	permission; paste at the cursor needs macOS's Accessibility permission,
	and a paste that cannot land leaves the text on the clipboard. Media
	pause is off by default: macOS can resume something the person had paused.
	Only the clipboard is built; the rest shows the target.
-->
<script lang="ts">
	import { Switch } from '@epicenter/ui/switch';
	import SettingsRow from '../SettingsRow.svelte';
	import SettingsSection from '../SettingsSection.svelte';
</script>

<svelte:head><title>Output · Whispering</title></svelte:head>

<SettingsSection title="When a take is ready" description="The text is always copied to the clipboard.">
	<SettingsRow
		label="Paste it where I am typing"
		description="Needs macOS's Accessibility permission. If a paste cannot land, the text stays on the clipboard. Not built yet."
		for="to-cursor"
		disabled
	>
		<Switch id="to-cursor" disabled />
	</SettingsRow>
</SettingsSection>

<SettingsSection title="While recording">
	<SettingsRow
		label="Pause music and video"
		description="May resume something you had paused yourself. Not built yet."
		for="pause-media"
		disabled
	>
		<Switch id="pause-media" disabled />
	</SettingsRow>
	<SettingsRow
		label="Show the floating pill over other apps"
		description="It shows now; turning it off is not built yet."
		for="pill"
		disabled
	>
		<Switch id="pill" checked disabled />
	</SettingsRow>
	<SettingsRow label="Play start and stop sounds" description="Not built yet." for="sounds" disabled>
		<Switch id="sounds" disabled />
	</SettingsRow>
</SettingsSection>

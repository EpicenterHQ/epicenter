<!--
	Settings · Shortcuts. The keys that record from any app. Two are always
	on: one starts and stops a take, one records while held. A third turns
	Hands-free on and off. Only the first is built; it is fixed for now.
-->
<script lang="ts">
	import Key from '../../Key.svelte';
	import SettingsRow from '../SettingsRow.svelte';
	import SettingsSection from '../SettingsSection.svelte';
</script>

<svelte:head><title>Shortcuts · Whispering</title></svelte:head>

<SettingsSection title="Shortcuts" description="These work from any app, while Whispering is open.">
	<SettingsRow label="Start and stop" description="Changing it is not built yet.">
		<Key keys="⌘⇧;" class="px-2 py-1 text-sm" />
	</SettingsRow>
	<SettingsRow label="Hold to talk" description="Records while the keys are held. Not built yet." disabled>
		<Key keys="⌥Space" class="px-2 py-1 text-sm opacity-60" />
	</SettingsRow>
	<SettingsRow label="Hands-free on or off" description="Not built yet." disabled>
		<span class="text-sm text-muted-foreground">None</span>
	</SettingsRow>
</SettingsSection>

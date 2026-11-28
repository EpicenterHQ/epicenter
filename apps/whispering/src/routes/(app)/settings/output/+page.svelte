<!--
	Settings · Output. Where a finished take's text goes, and what Whispering
	does around a take. The text always reaches the clipboard, which needs no
	permission. Paste at the cursor also presses the paste keys in the app in
	front; on a Mac that needs the Accessibility permission, and until it is
	granted the row says so and offers the place to grant it. Media pause is
	off by default: it resumes only if something was playing, but it is still the
	app reaching into another one. A browser tab can do none of these but the
	clipboard, and its rows say so.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Switch } from '@epicenter/ui/switch';
	import { toastOnError } from '@epicenter/ui/toast-on-error';
	import { createQuery } from '@tanstack/svelte-query';
	import { runMutation } from 'wellcrafted/query';
	import type { Settings } from '#lib/data/settings.ts';
	import { paste, pill } from '#lib/platform/index.ts';
	import { pasteQueries, queryClient, settingsMutations, settingsQueries } from '#lib/queries.ts';
	import SettingsRow from '../SettingsRow.svelte';
	import SettingsSection from '../SettingsSection.svelte';

	const settings = createQuery(() => settingsQueries.read());
	const pasting = $derived(settings.data?.['output.paste'] === true);
	/** Whether macOS lets a paste land; asked again when the window comes back from System Settings. */
	const allowed = createQuery(() => ({
		...pasteQueries.allowed(),
		enabled: paste.available && pasting,
		refetchOnWindowFocus: 'always' as const,
	}));
	const blocked = $derived(pasting && paste.available && allowed.data === false);
	/** A browser tab has no other app to reach. */
	const desktopOnly = paste.available ? undefined : 'Needs the desktop app.';

	async function save(change: Partial<Settings>) {
		const saved = await runMutation(queryClient, settingsMutations.update, change);
		if (saved.error) toastOnError(saved, 'Could not save the setting');
	}
</script>

<svelte:head><title>Output · Whispering</title></svelte:head>

<SettingsSection title="When a take is ready" description="The text is always copied to the clipboard.">
	<SettingsRow
		label="Paste it where I am typing"
		description={desktopOnly ??
			'Presses the paste keys in the app in front. With Hands-free on, everything the microphone hears as speech is typed there.'}
		for="to-cursor"
		disabled={!paste.available}
		error={blocked ? 'macOS has not allowed Whispering to paste yet. Until it does, the text stays on the clipboard.' : undefined}
	>
		{#if blocked}
			<Button variant="outline" size="sm" onclick={() => paste.ask()}>Allow in System Settings</Button>
		{/if}
		<Switch
			id="to-cursor"
			checked={pasting}
			disabled={!paste.available}
			onCheckedChange={(on) => save({ 'output.paste': on })}
		/>
	</SettingsRow>
</SettingsSection>

<SettingsSection title="While recording">
	<SettingsRow
		label="Pause music and video"
		description={desktopOnly ?? 'Resumes after the take, and only if something was playing. With Hands-free on, it stays paused while Whispering listens.'}
		for="pause-media"
		disabled={!paste.available}
	>
		<Switch
			id="pause-media"
			checked={settings.data?.['output.pauseMedia'] === true}
			disabled={!paste.available}
			onCheckedChange={(on) => save({ 'output.pauseMedia': on })}
		/>
	</SettingsRow>
	<SettingsRow
		label="Show the floating pill over other apps"
		description={pill.available ? 'A small bar with the clock, the level and Stop, while something is happening.' : 'Needs the desktop app.'}
		for="pill"
		disabled={!pill.available}
	>
		<Switch
			id="pill"
			checked={pill.available && settings.data?.['output.pill'] !== false}
			disabled={!pill.available}
			onCheckedChange={(on) => save({ 'output.pill': on })}
		/>
	</SettingsRow>
	<SettingsRow
		label="Play start and stop sounds"
		description="A short note as a take starts and as it ends. With Hands-free on, as listening starts and ends."
		for="sounds"
	>
		<Switch
			id="sounds"
			checked={settings.data?.['output.sounds'] === true}
			onCheckedChange={(on) => save({ 'output.sounds': on })}
		/>
	</SettingsRow>
</SettingsSection>

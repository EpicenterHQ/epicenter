<!--
	Settings · Shortcuts. The keys that record from any app: one starts and
	stops a take, one records while held, and one turns Hands-free on and
	off; Escape cancels a take while one records. Under them, whether the
	system opens Whispering at login. Each is changed by pressing the new keys, and saved at once. A
	shortcut another app holds says so under its row. A browser tab has no
	global shortcuts, and says that instead.
-->
<script lang="ts">
	import { toastOnError } from '@epicenter/ui/toast-on-error';
	import { createQuery } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { runMutation } from 'wellcrafted/query';
	import type { Settings } from '#lib/data/settings.ts';
	import { Switch } from '@epicenter/ui/switch';
	import { autostart, shortcuts } from '#lib/platform/index.ts';
	import {
		autostartMutations,
		autostartQueries,
		queryClient,
		settingsMutations,
		settingsQueries,
	} from '#lib/queries.ts';
	import { shortcutHolds } from '#lib/shortcut-holds.svelte.ts';
	import SettingsRow from '../SettingsRow.svelte';
	import SettingsSection from '../SettingsSection.svelte';
	import ShortcutInput from './ShortcutInput.svelte';

	const settings = createQuery(() => settingsQueries.read());
	const off = !shortcuts.available;
	const startsAtLogin = createQuery(() => ({
		...autostartQueries.enabled(),
		enabled: autostart.available,
	}));

	async function setAutostart(on: boolean) {
		const changed = await runMutation(queryClient, autostartMutations.set, { on });
		if (changed.error)
			toast.error('Could not change it', { description: changed.error.message });
	}

	async function save(change: Partial<Settings>) {
		const saved = await runMutation(queryClient, settingsMutations.update, change);
		if (saved.error) toastOnError(saved, 'Could not save the shortcut');
	}
</script>

<svelte:head><title>Shortcuts · Whispering</title></svelte:head>

<SettingsSection
	title="Shortcuts"
	description={off
		? 'Shortcuts that work from any app need the desktop app.'
		: 'These work from any app, while Whispering is open. Press one to change it.'}
>
	<SettingsRow
		label="Start and stop"
		description="Press once to start a take, and again to finish it."
		for="shortcut-toggle"
		disabled={off}
		error={shortcutHolds.problem('toggle')}
	>
		<ShortcutInput
			id="shortcut-toggle"
			keys={settings.data?.['shortcut.toggle'] ?? ''}
			disabled={off}
			onchange={(keys) => save({ 'shortcut.toggle': keys })}
		/>
	</SettingsRow>
	<SettingsRow
		label="Hold to talk"
		description="Records while the keys are held, and finishes when you let go. Off while Hands-free listens."
		for="shortcut-hold"
		disabled={off}
		error={shortcutHolds.problem('hold')}
	>
		<ShortcutInput
			id="shortcut-hold"
			keys={settings.data?.['shortcut.hold'] ?? ''}
			removable
			disabled={off}
			onchange={(keys) => save({ 'shortcut.hold': keys })}
		/>
	</SettingsRow>
	<SettingsRow
		label="Hands-free on or off"
		description="Keeps the microphone open and takes down each thing you say."
		for="shortcut-hands-free"
		disabled={off}
		error={shortcutHolds.problem('handsFree')}
	>
		<ShortcutInput
			id="shortcut-hands-free"
			keys={settings.data?.['shortcut.handsFree'] ?? ''}
			removable
			disabled={off}
			onchange={(keys) => save({ 'shortcut.handsFree': keys })}
		/>
	</SettingsRow>
	<SettingsRow
		label="Escape cancels a take"
		description="While a take records, Escape throws it away from any app. The rest of the time Escape is left alone."
		for="escape-cancels"
		disabled={off}
	>
		<Switch
			id="escape-cancels"
			checked={!off && settings.data?.['shortcut.escapeCancels'] !== false}
			disabled={off}
			onCheckedChange={(on) => save({ 'shortcut.escapeCancels': on })}
		/>
	</SettingsRow>
</SettingsSection>

<SettingsSection title="Startup" description="The shortcuts work only while Whispering is open.">
	<SettingsRow
		label="Open Whispering when I log in"
		description={autostart.available
			? 'It starts with its window closed. Click it in the Dock to see it.'
			: 'Needs the desktop app.'}
		for="autostart"
		disabled={!autostart.available}
	>
		<Switch
			id="autostart"
			checked={startsAtLogin.data === true}
			disabled={!autostart.available}
			onCheckedChange={(on) => setAutostart(on)}
		/>
	</SettingsRow>
</SettingsSection>

<script lang="ts">
	import { getWhisperingApp } from '$lib/whispering/context';
	const app = getWhisperingApp();
	import { DEVICE_DEFAULTS } from '$lib/operations/settings.js';
	import * as Field from '@epicenter/ui/field';
	import { SettingSwitch } from '$lib/components/settings';
</script>

<svelte:head> <title>Sound Settings - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>Sound</Field.Legend>
	<Field.Description>
		Configure your Whispering sound preferences.
	</Field.Description>
	<Field.Separator />
	<Field.Group>
		<Field.Set>
			<Field.Legend variant="label">Manual Recording Sounds</Field.Legend>
			<Field.Description>
				Configure sounds for manual recording events.
			</Field.Description>
			<Field.Group>
				<SettingSwitch
					checked={app.local.kv.get('soundManualStart') ?? DEVICE_DEFAULTS.soundManualStart}
					onCheckedChange={checked => app.local.kv.update({ soundManualStart: checked })}
					label="Play sound when starting manual recording"
				/>
				<SettingSwitch
					checked={app.local.kv.get('soundManualStop') ?? DEVICE_DEFAULTS.soundManualStop}
					onCheckedChange={checked => app.local.kv.update({ soundManualStop: checked })}
					label="Play sound when stopping manual recording"
				/>
				<SettingSwitch
					checked={app.local.kv.get('soundManualCancel') ?? DEVICE_DEFAULTS.soundManualCancel}
					onCheckedChange={checked => app.local.kv.update({ soundManualCancel: checked })}
					label="Play sound when canceling manual recording"
				/>
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<Field.Set>
			<Field.Legend variant="label">VAD Recording Sounds</Field.Legend>
			<Field.Description>
				Configure sounds for voice-activated detection events.
			</Field.Description>
			<Field.Group>
				<SettingSwitch
					checked={app.local.kv.get('soundVadStart') ?? DEVICE_DEFAULTS.soundVadStart}
					onCheckedChange={checked => app.local.kv.update({ soundVadStart: checked })}
					label="Play sound when starting VAD recording session"
				/>
				<SettingSwitch
					checked={app.local.kv.get('soundVadCapture') ?? DEVICE_DEFAULTS.soundVadCapture}
					onCheckedChange={checked => app.local.kv.update({ soundVadCapture: checked })}
					label="Play sound on VAD capture"
				/>
				<SettingSwitch
					checked={app.local.kv.get('soundVadStop') ?? DEVICE_DEFAULTS.soundVadStop}
					onCheckedChange={checked => app.local.kv.update({ soundVadStop: checked })}
					label="Play sound when stopping VAD recording session"
				/>
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<Field.Set>
			<Field.Legend variant="label">Completion Sounds</Field.Legend>
			<Field.Description>
				Configure sounds for transcription and recipe completion.
			</Field.Description>
			<Field.Group>
				<SettingSwitch
					checked={app.local.kv.get('soundTranscriptionComplete') ?? DEVICE_DEFAULTS.soundTranscriptionComplete}
					onCheckedChange={checked => app.local.kv.update({ soundTranscriptionComplete: checked })}
					label="Play sound after transcription"
				/>
				<SettingSwitch
					checked={app.local.kv.get('soundRecipeComplete') ?? DEVICE_DEFAULTS.soundRecipeComplete}
					onCheckedChange={checked => app.local.kv.update({ soundRecipeComplete: checked })}
					label="Play sound after a recipe runs"
				/>
			</Field.Group>
		</Field.Set>
	</Field.Group>
</Field.Set>

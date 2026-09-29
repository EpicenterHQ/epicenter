<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Link } from '@epicenter/ui/link';
	import InfoIcon from '@lucide/svelte/icons/info';
	import { createMutation } from '@tanstack/svelte-query';
	import { resultMutationOptions } from 'wellcrafted/query';
	import { SettingSelect, SettingSwitch, SettingNumberInput, AdvancedDisclosure } from '$lib/components/settings';
	import { BITRATE_OPTIONS, RECORDING_TRIGGER_OPTIONS } from '$lib/constants/audio';
	import { report } from '$lib/report';
	import { asDeviceIdentifier } from '@epicenter/recorder';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { os } from '#platform/os';
	import { manualRecorderConfig } from '#platform/manual-recorder-config';
	import { tauri } from '#platform/tauri';
	import { exportRecordingsMarkdown } from '$lib/whispering/recordings-markdown-export';
	import ManualSelectRecordingDevice from './ManualSelectRecordingDevice.svelte';
	import VadSelectRecordingDevice from './VadSelectRecordingDevice.svelte';
	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();

	const exportRecordings = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['recordings', 'export'],
			mutationFn: () => exportRecordingsMarkdown(app),
		}),
	);
</script>

<svelte:head> <title>Recording Settings - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>Recording</Field.Legend>
	<Field.Description>
		Configure your Whispering recording preferences.
	</Field.Description>
	<Field.Separator />
	<Field.Group>
		<SettingSelect
			store={app.settings}
			key="recordingTrigger"
			label="Recording Trigger"
			items={RECORDING_TRIGGER_OPTIONS}
			description="Choose how recording starts: {RECORDING_TRIGGER_OPTIONS.map(
				(option) => option.label.toLowerCase(),
			).join(', ')}"
		/>

		<SettingSwitch
			key="recordingPausePlayback"
			label="Pause playback while recording"
			description="Whispering pauses media playing on your computer (music, video, browser tabs) while your voice is being captured, then tries to resume it after. In voice activated mode it pauses only while you actually speak, so music keeps playing between phrases. Works with most apps in your system media controls. A few can't be paused, and on macOS the resume can occasionally wake a different app that was already paused."
		/>

		{#if app.recordings.remoteAvailable}
			<SettingSwitch
				key="recordingAutoUpload"
				label="Upload new recordings"
				description="After saving a new recording on this device, try once to copy its audio to your online storage. Failed uploads stay local and are not retried automatically."
			/>
		{/if}

		{#if app.settings.get('recordingTrigger') === 'manual'}
			<ManualSelectRecordingDevice
				bind:selected={() => {
					const selected = manualRecorderConfig.deviceId;
					return selected ? asDeviceIdentifier(selected) : null;
					},
					(selected) => (manualRecorderConfig.deviceId = selected)}
			/>
		{:else if app.settings.get('recordingTrigger') === 'vad'}
			{#if os.isLinux}
				<Alert.Root variant="destructive">
					<InfoIcon class="size-4" />
					<Alert.Title>
						Voice Activated not supported on Linux
					</Alert.Title>
					<Alert.Description>
						Voice Activated Detection (VAD) requires the browser's Navigator
						API, which is not fully supported in Tauri on Linux. Device
						enumeration and recording will fail. Please use Manual recording
						instead.
						<Link
							href="https://github.com/EpicenterHQ/epicenter/issues/839"
							target="_blank"
						>
							Learn more →
						</Link>
					</Alert.Description>
				</Alert.Root>
			{:else}
				{#if tauri && os.isApple}
					<Alert.Root variant="warning">
						<InfoIcon class="size-4" />
						<Alert.Title>
							Global Shortcuts May Be Unreliable
						</Alert.Title>
						<Alert.Description>
							VAD uses browser-owned capture. macOS App Nap may delay browser
							recording logic when Whispering is not in focus.
						</Alert.Description>
					</Alert.Root>
				{/if}
				<Alert.Root>
					<InfoIcon class="size-4" />
					<Alert.Title>
						Voice Activated Detection
					</Alert.Title>
					<Alert.Description>
						VAD uses the browser's Web Audio API for real-time voice detection.
						Captured speech is encoded to uncompressed WAV format.
					</Alert.Description>
				</Alert.Root>
			{/if}

			<VadSelectRecordingDevice
				bind:selected={() => {
					const selected = deviceConfig.get('recording.navigator.deviceId');
					return selected ? asDeviceIdentifier(selected) : null;
					},
					(selected) =>
						deviceConfig.set('recording.navigator.deviceId', selected)}
			/>

			<AdvancedDisclosure>
				<SettingNumberInput
					store={deviceConfig}
					key="recording.vad.redemptionMs"
					label="End-of-speech silence (ms)"
					placeholder="1400"
					min={100}
					step={100}
					description="How long you can pause mid-thought before the capture is closed and sent for transcription. Default 1400; raise toward 2500 to tolerate longer pauses."
				/>
				<SettingNumberInput
					store={deviceConfig}
					key="recording.vad.minSpeechMs"
					label="Minimum speech (ms)"
					placeholder="400"
					min={0}
					step={50}
					description="Shortest sound that counts as speech. Default 400; raise to ~600 to ignore coughs, clicks, and other brief non-speech noises."
				/>
				<SettingNumberInput
					store={deviceConfig}
					key="recording.vad.positiveSpeechThreshold"
					label="Speech start sensitivity (0-1)"
					placeholder="0.3"
					min={0}
					max={1}
					step={0.05}
					description="Model confidence required to open a speech segment. Default 0.3; raise to reject more non-speech, lower if quiet speech is missed."
				/>
				<SettingNumberInput
					store={deviceConfig}
					key="recording.vad.negativeSpeechThreshold"
					label="Speech end sensitivity (0-1)"
					placeholder="0.25"
					min={0}
					max={1}
					step={0.05}
					description="Confidence below which speech is considered to have ended. Default 0.25; keep it below the start sensitivity."
				/>
				<SettingNumberInput
					store={deviceConfig}
					key="recording.vad.preSpeechPadMs"
					label="Pre-speech padding (ms)"
					placeholder="800"
					min={0}
					step={50}
					description="Audio kept before the detected speech start, so the first syllable is not clipped. Default 800."
				/>
			</AdvancedDisclosure>
		{/if}

		{#if app.settings.get('recordingTrigger') === 'manual' && !tauri}
			<SettingSelect
				store={deviceConfig}
				key="recording.navigator.bitrateKbps"
				label="Bitrate"
				items={BITRATE_OPTIONS}
				description="The bitrate of the recording. Higher values mean better quality but larger file sizes."
			/>
		{/if}

		<Field.Field>
			<Field.Label>Export recordings</Field.Label>
			<Button
				variant="outline"
				class="w-fit"
				onclick={() => {
					exportRecordings.mutate(undefined, {
						onSuccess: (data) => {
							if (data.written === 0) {
								report.info({
									title: 'Nothing to export',
									description: 'You have no recordings yet.',
								});
								return;
							}
							report.success({
								title: 'Recordings exported',
								description: `Saved ${data.written} ${data.written === 1 ? 'recording' : 'recordings'} as a zip file.`,
							});
						},
						onError: (error) => {
							// Cancelling the Save dialog is not a failure.
							if (error.name === 'SaveCancelled') return;
							report.error({
								title: 'Export failed',
								cause: error,
							});
						},
					});
				}}
				disabled={exportRecordings.isPending}
			>
				{exportRecordings.isPending ? 'Exporting...' : 'Export recordings (.zip)'}
			</Button>
			<Field.Description>
				Download every recording as a zip of Markdown files. This is a
				snapshot: later edits in Whispering do not change the downloaded file.
			</Field.Description>
		</Field.Field>
	</Field.Group>
</Field.Set>

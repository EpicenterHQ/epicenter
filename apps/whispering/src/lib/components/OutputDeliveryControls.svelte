<script lang="ts">
	import { getSetting } from '$lib/operations/settings.js';
	import { Button } from '@epicenter/ui/button';
	import LockIcon from '@lucide/svelte/icons/lock';
	import {
		clipboardFallback,
		pasteBack,
	} from '$lib/components/accessibility-feature-copy';
	import { openSystemSettings } from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import { SettingSwitch } from '$lib/components/settings';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';
	import type { BooleanSettingKey } from '$lib/operations/settings.js';
	import { tauri } from '#platform/tauri';
	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();

	// One scope's full output delivery UI: copy to clipboard, paste at cursor (with
	// its macOS Accessibility notice), and the dependent "press Enter" sub-toggle.
	// These three always travel together because delivery.ts routes both the
	// transcription and recipe scopes through the same path (clipboard, then a
	// synthetic Cmd+V for cursor, then Enter), so the same trio and the same
	// Accessibility caveat apply to both. Driving every surface (the two Settings
	// output groups and the home capture popover) from this one component keeps the
	// labels, the remediation copy, and the gating from ever drifting.
	//
	// Scope is the only axis that varies: the keys are `output.<scope>.*` and every
	// label is the scope's noun plugged into one phrasing, so a label change happens
	// in exactly one place. Paste-at-cursor stays interactive without the grant (it
	// records intent); Rust's bounded grant watcher notices when Accessibility
	// lands, with no second visit needed to flip it back on.
	type OutputScope = 'transcription' | 'recipe';
	let { scope }: { scope: OutputScope } = $props();

	const SCOPES = {
		transcription: {
			noun: 'transcript',
			clipboard: 'outputTranscriptionClipboard',
			cursor: 'outputTranscriptionCursor',
			enter: 'outputTranscriptionEnter',
		},
		recipe: {
			noun: 'recipe output',
			clipboard: 'outputRecipeClipboard',
			cursor: 'outputRecipeCursor',
			enter: 'outputRecipeEnter',
		},
	} satisfies Record<
		OutputScope,
		{
			noun: string;
			clipboard: BooleanSettingKey;
			cursor: BooleanSettingKey;
			enter: BooleanSettingKey;
		}
	>;
	const delivery = $derived(SCOPES[scope]);
</script>

<SettingSwitch
	key={delivery.clipboard}
	label={`Copy ${delivery.noun} to clipboard`}
/>

<SettingSwitch key={delivery.cursor} label={`Paste ${delivery.noun} at cursor`} />

{#if tauri && dictationCapability.needsAccessibility}
	<!-- The toggle stays on and interactive (it records intent), but the paste
	can't fire without the macOS Accessibility grant. Annotate the current
	capability inline; offer the grant only when there is one to give (untrusted
	or stale, not Wayland). -->
	<div
		class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground"
	>
		<LockIcon class="size-3.5 shrink-0" aria-hidden="true" />
		<span>{pasteBack} {clipboardFallback}</span>
		<Button
			variant="link"
			class="h-auto p-0 text-sm font-normal"
			onclick={openSystemSettings}
		>
			Open Settings
		</Button>
	</div>
{/if}

{#if tauri && getSetting(app.device.kv, delivery.cursor)}
	<div class:opacity-50={dictationCapability.needsAccessibility}>
		<SettingSwitch
			key={delivery.enter}
			label={`Press Enter after pasting ${delivery.noun}`}
		/>
	</div>
{/if}

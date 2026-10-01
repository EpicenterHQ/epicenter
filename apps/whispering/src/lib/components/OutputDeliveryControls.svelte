<script lang="ts">
	import { local } from '$lib/whispering/local.js';
	import { DEVICE_DEFAULTS } from '$lib/operations/settings.js';
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

	// One scope's full output delivery UI: copy to clipboard, paste at cursor (with
	// its macOS Accessibility notice), and the dependent "press Enter" sub-toggle.
	// Clipboard, cursor paste, and Enter share the same accessibility behavior.
	//
	// Paste-at-cursor stays interactive without the grant (it
	// records intent); Rust's bounded grant watcher notices when Accessibility
	// lands, with no second visit needed to flip it back on.
	const clipboard = 'outputTranscriptionClipboard' satisfies BooleanSettingKey;
	const cursor = 'outputTranscriptionCursor' satisfies BooleanSettingKey;
	const enter = 'outputTranscriptionEnter' satisfies BooleanSettingKey;
</script>

<SettingSwitch
	checked={local.kv.get(clipboard) ?? DEVICE_DEFAULTS[clipboard]}
	onCheckedChange={(checked) =>
		local.kv.update({ [clipboard]: checked })}
	label="Copy transcript to clipboard"
/>

<SettingSwitch
	checked={local.kv.get(cursor) ?? DEVICE_DEFAULTS[cursor]}
	onCheckedChange={(checked) => local.kv.update({ [cursor]: checked })}
	label="Paste transcript at cursor"
/>

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

{#if tauri && (local.kv.get(cursor) ?? DEVICE_DEFAULTS[cursor])}
	<div class:opacity-50={dictationCapability.needsAccessibility}>
		<SettingSwitch
			checked={local.kv.get(enter) ?? DEVICE_DEFAULTS[enter]}
			onCheckedChange={(checked) =>
				local.kv.update({ [enter]: checked })}
			label="Press Enter after pasting transcript"
		/>
	</div>
{/if}

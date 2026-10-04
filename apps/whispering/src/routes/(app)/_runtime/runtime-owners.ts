import { recordingOverlayRuntimeOwner } from '#platform/recording-overlay-owner';
import { dictationCapability } from '$lib/state/dictation-capability.svelte';
import { attachAnalytics } from './attach-analytics.svelte';
import { attachAutoPasteIntent } from './attach-auto-paste-intent.svelte';
import { attachDebugCommands } from './attach-debug-commands';
import { attachDictationExceptions } from './attach-dictation-exceptions.svelte';
import { attachLocalShortcutListener } from './attach-local-shortcut-listener.svelte';
import { attachShortcutSync } from './attach-shortcut-sync';
import { attachUnloadPolicy } from './attach-unload-policy.svelte';
import type { RuntimeOwner } from './types';

export const runtimeOwners = [
	{ attach: attachDebugCommands },
	{ attach: attachAnalytics },
	{ attach: attachLocalShortcutListener },
	{ attach: attachShortcutSync },
	...(recordingOverlayRuntimeOwner ? [recordingOverlayRuntimeOwner] : []),
	{ attach: attachDictationExceptions },
	{ attach: attachUnloadPolicy },
	{ attach: attachAutoPasteIntent },
	{ attach: dictationCapability.attach },
] satisfies RuntimeOwner[];

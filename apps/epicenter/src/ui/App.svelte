<script lang="ts">
	import * as Tabs from '@epicenter/ui/tabs';
	import { commands, events } from './bindings.gen';
	import Chat from './Chat.svelte';
	import { isDesktopHost } from './runtime.ts';
	import { createSession } from './session.svelte.ts';
	import Settings from './Settings.svelte';

	/**
	 * Settings: the window labelled `home`, beside the applications rather than
	 * a shell above them (ADR-0209).
	 *
	 * Two panes and nothing else. Epicenter opens to the Folders window, which
	 * lists the folders, the apps that open them, and every other app; this
	 * window holds what the Folders window does not: the conversation and
	 * host administration, including the local transcription model (ADR-0180,
	 * ADR-0537). The session is owned here, above the visual contents, and
	 * `Tabs.Content forceMount` hides an inactive pane rather than unmounting
	 * it, so switching panes never disturbs the live socket, the transcript, or
	 * an unsent draft.
	 */

	const { sessionReady }: { sessionReady: Promise<void> } = $props();
	// The bootstrap promise is fixed for this document lifetime.
	// svelte-ignore state_referenced_locally
	const session = createSession({ ready: sessionReady });

	const isDesktop = isDesktopHost();
	// The desktop opens this window as Settings, from the Folders window or the
	// tray, so it lands there; a browser or remote session cannot administer
	// this device, so it opens on the conversation it can hold. The host
	// answers this synchronously, so the first paint is already right.
	let pane = $state(isDesktop ? 'settings' : 'chat');

	// An application whose local transcription is unavailable can send the user
	// here. The intent lives in the host, so this window claims it rather than
	// being handed it: on mount (Home may have been absent or still booting when
	// the request arrived) and again on each nudge (Home was already running).
	// Taking is destructive, so however many nudges arrive, one request opens
	// Settings once.
	async function claimPendingSection() {
		const section = await commands.takePendingHomeSection();
		if (section === 'transcription') pane = 'settings';
	}
	if (isDesktop) {
		void claimPendingSection();
		void events.homeSectionPending.listen(() => void claimPendingSection());
	}

	const connectionIndicator = {
		connecting: { label: 'Connecting', dot: 'bg-warning' },
		open: { label: 'Connected', dot: 'bg-success' },
		closed: { label: 'Disconnected', dot: 'bg-destructive' },
	} as const;
</script>

<Tabs.Root bind:value={pane} class="h-full text-sm">
	<header class="flex flex-none items-center gap-3 border-b px-3 py-2">
		<Tabs.List variant="line">
			<Tabs.Trigger value="chat">Chat</Tabs.Trigger>
			<Tabs.Trigger value="settings">Settings</Tabs.Trigger>
		</Tabs.List>
		<span
			class="ms-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground"
		>
			<span
				class="size-1.5 rounded-full {connectionIndicator[session.connection]
					.dot}"
			></span>
			{connectionIndicator[session.connection].label}
		</span>
	</header>

	<!-- Each pane owns its own padding so a full-height empty or loading state
	     can center against the whole pane instead of a padded box. -->
	<Tabs.Content forceMount value="chat" class="min-h-0">
		<Chat {session} />
	</Tabs.Content>

	<Tabs.Content forceMount value="settings" class="min-h-0 overflow-y-auto">
		<Settings />
	</Tabs.Content>
</Tabs.Root>

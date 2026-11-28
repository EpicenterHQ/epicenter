<!--
	Development only. Home's recorder, the line saying what dictation needs,
	the first-run panel, and the pill, handed a made-up `DictationView`
	instead of the real one, so every state can be seen without a
	microphone (hold to talk, Hands-free, a paste that fell back). The
	screens cannot tell the difference: that is the line between what they
	show and how dictation happens.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Label } from '@epicenter/ui/label';
	import type {
		DictationView,
		HandsFree,
		Need,
		Outcome,
		Take,
	} from '#lib/dictation-view.ts';
	import { setDictation } from '#lib/dictation-view.ts';
	import { goto } from '$app/navigation';
	import { pill } from '#lib/platform/index.ts';
	import FirstRun from '../FirstRun.svelte';
	import NeedsLine from '../NeedsLine.svelte';
	import Pill from '../../Pill.svelte';
	import RecorderPanel from '../RecorderPanel.svelte';
	import WithView from './WithView.svelte';

	type Scene = {
		label: string;
		take?: Take;
		handsFree?: HandsFree;
		outcome?: Outcome;
		silent?: boolean;
		needs?: Need[];
		cleaning?: boolean;
	};

	const ACCESSIBILITY: Need = {
		id: 'accessibility',
		problem: 'Paste at the cursor is off: macOS has not allowed it. Text goes to your clipboard instead.',
		fix: { label: 'Allow in System Settings', href: '/settings/output' },
	};
	const SERVER: Need = {
		id: 'server',
		problem: 'No transcription server is set. Recordings are kept, without text.',
		fix: { label: 'Set up transcription', href: '/settings/transcription' },
	};

	const started = Date.now() - 17_000;
	const READY: Scene = { label: 'Ready' };
	const SCENES: Scene[] = [
		READY,
		{ label: 'Needs fixing', needs: [SERVER, ACCESSIBILITY] },
		{ label: 'Recording (shortcut)', take: { kind: 'recording', startedAt: started, trigger: 'shortcut' } },
		{ label: 'Recording (held key)', take: { kind: 'recording', startedAt: started, trigger: 'hold' } },
		{ label: 'Recording, silent mic', take: { kind: 'recording', startedAt: started, trigger: 'button' }, silent: true },
		{ label: 'Hands-free, listening', handsFree: { kind: 'listening' } },
		{ label: 'Hands-free, heard speech', handsFree: { kind: 'listening' }, take: { kind: 'recording', startedAt: started, trigger: 'voice' } },
		{ label: 'Saving', take: { kind: 'stopping' } },
		{ label: 'Hands-free, previous phrase', handsFree: { kind: 'listening' }, outcome: { kind: 'transcribing', id: 'x' } },
		{ label: 'Transcribing', outcome: { kind: 'transcribing', id: 'x' } },
		{ label: 'Cleaning up', outcome: { kind: 'transcribing', id: 'x' }, cleaning: true },
		{ label: 'Copied', outcome: { kind: 'delivered', id: 'x', to: 'clipboard', at: 0 } },
		{ label: 'Pasted', outcome: { kind: 'delivered', id: 'x', to: 'cursor', at: 0 } },
		{ label: 'Paste fell back', outcome: { kind: 'copiedInstead', id: 'x', why: 'the app in front would not take a paste.' } },
		{ label: 'Failed: no key', outcome: { kind: 'failed', id: 'x', label: 'Needs a key', why: 'The server needs an API key.', fix: { label: 'Set up transcription', href: '/settings/transcription' } } },
	];

	let scene = $state(READY);
	/** When the scene was picked: a delivery lands then, so the pill's moment can be watched. */
	let pickedAt = $state(Date.now());
	/** A level that moves like speech, so the meters can be judged. */
	let level = $state(0);
	$effect(() => {
		const timer = setInterval(() => (level = 0.02 + Math.random() * 0.3), 80);
		return () => clearInterval(timer);
	});

	/**
	 * A made-up view showing `shown()`. A delivery lands at `landedAt()`, so
	 * the pill's moment can be watched; the gallery puts it an hour ahead,
	 * so it stays.
	 */
	const viewOf = (shown: () => Scene, landedAt: () => number): DictationView => ({
		take: () => shown().take ?? { kind: 'idle' },
		keys: () => ({ toggle: '⌘⇧;', hold: '⌥ Space' }),
		level: () => level,
		silent: () => shown().silent ?? false,
		handsFree: () => shown().handsFree ?? { kind: 'off' },
		outcome: () => {
			const outcome = shown().outcome ?? { kind: 'none' };
			return outcome.kind === 'delivered' ? { ...outcome, at: landedAt() } : outcome;
		},
		needs: () => shown().needs ?? [],
		isTranscribing: () => false,
		isCleaning: () => shown().cleaning ?? false,
		toggle: () => {},
		cancel: () => {},
		dismiss: () => (scene = READY),
		show: (href) => void goto(href),
		setHandsFree: () => {},
		transcribe: () => {},
		forget: () => {},
	});
	const view = viewOf(() => scene, () => pickedAt);
	setDictation(view);

	/**
	 * In the desktop app, also send the chosen state to the real floating
	 * pill, so its window can be judged on the real desktop. Turning it off
	 * hides the pill; a real take sends its own state again.
	 */
	let mirror = $state(false);
	$effect(() => {
		if (!mirror) return;
		const outcome = view.outcome();
		pill.publish({
			take: view.take(),
			outcome,
			level: view.level(),
			silent: view.silent(),
			handsFree: view.handsFree(),
			keys: view.keys(),
			cleaning: outcome.kind === 'transcribing' && view.isCleaning(outcome.id),
		});
		return () =>
			pill.publish({
				take: { kind: 'idle' },
				outcome: { kind: 'none' },
				level: 0,
				silent: false,
				handsFree: { kind: 'off' },
				keys: view.keys(),
				cleaning: false,
			});
	});
	const HOUR = 3_600_000;
</script>

<svelte:head><title>Preview · Whispering</title></svelte:head>

<div class="min-h-0 flex-1 overflow-y-auto">
	<div class="flex flex-wrap gap-1 border-b p-3" role="group" aria-label="State">
		{#each SCENES as option (option.label)}
			<Button
				size="sm"
				variant={scene === option ? 'secondary' : 'ghost'}
				aria-pressed={scene === option}
				onclick={() => {
					scene = option;
					pickedAt = Date.now();
				}}
			>
				{option.label}
			</Button>
		{/each}
		<div class="ml-auto flex items-center gap-2 px-2">
			<Checkbox id="mirror" bind:checked={mirror} />
			<Label for="mirror" class="text-muted-foreground">Show on the floating pill (desktop app)</Label>
		</div>
	</div>

	<div class="mx-auto grid w-full max-w-4xl gap-8 p-6 md:grid-cols-[1fr_auto]">
		<section class="flex flex-col gap-4" aria-label="Home">
			<h2 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Home</h2>
			<RecorderPanel />
			<NeedsLine />
		</section>
		<section class="flex flex-col gap-4" aria-label="Pill">
			<h2 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Pill, over other apps</h2>
			<div
				class="flex h-24 w-72 items-center justify-center rounded-lg bg-muted text-xs text-muted-foreground empty:before:content-['Hidden:_nothing_is_happening']"
			><Pill /></div>
		</section>
	</div>

	<section class="mx-auto flex w-full max-w-4xl flex-col gap-3 p-6" aria-label="First run">
		<h2 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
			First run: the model is not downloaded
		</h2>
		<div class="grid gap-4 lg:grid-cols-2">
			{#each [{}, { share: 0.42 }, { error: 'Failed to download model: the connection was reset.' }] as state, i (i)}
				<div>
					<FirstRun name="Parakeet TDT 0.6B v3" sizeBytes={485_000_000} {...state} ondownload={() => {}} />
				</div>
			{/each}
		</div>
	</section>

	<section class="mx-auto flex w-full max-w-4xl flex-col gap-3 p-6" aria-label="Every pill">
		<h2 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Every pill</h2>
		<div class="grid gap-x-8 gap-y-4 rounded-lg bg-gradient-to-br from-sky-200 via-neutral-300 to-neutral-500 p-6 sm:grid-cols-2">
			{#each SCENES.filter((s) => s.take || s.outcome || s.handsFree) as option (option.label)}
				<div class="flex flex-col gap-1.5">
					<span class="text-xs text-neutral-800">{option.label}</span>
					<WithView view={viewOf(() => option, () => Date.now() + HOUR)}><Pill /></WithView>
				</div>
			{/each}
		</div>
	</section>
</div>

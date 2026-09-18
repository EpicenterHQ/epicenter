<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { openFailure } from './open-failure.js';

	/**
	 * The screen a person meets when their data was opened and refused.
	 *
	 * Mounted by the boot node, which is the narrowest node not shared with
	 * `/auth/callback` (ADR-0345). Which sentence, which repair, and whether the
	 * library's own message belongs underneath are all `openFailure`'s; this
	 * renders them and decides nothing.
	 */
	type CannotOpenScreenProps = {
		/** The application's name, as the heading, e.g. `'Honeycrisp'`. */
		appName: string;
		/** What this application calls a person's stuff, plural, e.g. `'notes'`. */
		noun: string;
		/**
		 * What the open failed with.
		 *
		 * `unknown` because nothing here reads it: it goes straight to
		 * `openFailure`, which picks the sentence off its `name`.
		 */
		error: unknown;
		/**
		 * Open again. A prop rather than `location.reload()`, because opening is a
		 * verb: the session owner replaces its session with `openApp(definition, { account })`
		 * using the same captured Account. Retrying keeps the document running.
		 */
		retry: () => void;
	};

	let { appName, noun, error, retry }: CannotOpenScreenProps = $props();

	const failure = $derived(openFailure(error, { appName, noun }));
</script>

<div class="flex h-dvh items-center justify-center p-6 text-center">
	<div class="flex max-w-sm flex-col items-center gap-4">
		<div class="space-y-2">
			<h1 class="text-lg font-semibold">{appName}</h1>
			<p class="text-sm text-muted-foreground">{failure.message}</p>
			{#if failure.detail !== undefined}
				<p class="text-xs text-muted-foreground/70">{failure.detail}</p>
			{/if}
		</div>
		<!-- No button under `none`. A runtime with no Web Locks is not repaired by
		     trying again, and a button that cannot help is worse than no button. -->
		{#if failure.repair !== 'none'}
			<Button size="lg" onclick={retry}>Try again</Button>
		{/if}
	</div>
</div>

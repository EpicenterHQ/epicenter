<script lang="ts">
	import { getPersonal } from '$lib/whispering/personal.js';
	const personal = getPersonal();
	import { PERSONAL_DEFAULTS } from '$lib/operations/settings.js';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Textarea } from '@epicenter/ui/textarea';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { AdvancedDisclosure } from '$lib/components/settings';

	// Null when the person has added no terms: the definition cannot default an array,
	// so "never touched" and "emptied" are the same empty list here.
	const dictionary = $derived(personal.kv.get('dictionary') ?? []);

	let newTerm = $state('');

	function addTerm() {
		const term = newTerm.trim();
		newTerm = '';
		// Injection-only and order-free, so dedupe and ignore blanks; a repeated
		// term would only bloat the prompt block.
		if (!term || dictionary.includes(term)) return;
		personal.kv.update({ dictionary: [...dictionary, term] });
	}

	function removeTerm(term: string) {
		personal.kv.update({
			dictionary: dictionary.filter((t) => t !== term),
		});
	}
</script>

<Field.Set>
	<Field.Legend variant="label">Speech profile</Field.Legend>
	<Field.Description>
		Known terms and cleanup instructions follow your account.
	</Field.Description>
	<Field.Group>
		<Field.Set>
			<Field.Legend variant="label">Cleanup instructions</Field.Legend>
			<Field.Description>
				Tell the cleanup step how to handle your speech.
			</Field.Description>
			<Field.Group>
				<AdvancedDisclosure>
						<Field.Field>
							<Field.Label for="polish-instructions">
								Cleanup instructions
							</Field.Label>
							<Textarea
								id="polish-instructions"
								placeholder={PERSONAL_DEFAULTS.polishInstructions}
								value={personal.kv.get('polishInstructions') ??
									PERSONAL_DEFAULTS.polishInstructions}
								onblur={(e) => {
									const next = e.currentTarget.value;
									if (
										next !==
										(personal.kv.get('polishInstructions') ??
											PERSONAL_DEFAULTS.polishInstructions)
									)
										personal.kv.update({ polishInstructions: next });
								}}
							/>
							<Field.Description>
								Keep cleanup close to the speaker's wording and intent.
							</Field.Description>
						</Field.Field>
				</AdvancedDisclosure>
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<Field.Set>
			<Field.Legend variant="label">Dictionary</Field.Legend>
			<Field.Description>
				Proper nouns and domain terms Whispering should know: names, jargon,
				product names. The AI keeps these spellings and maps obvious mishearings
				onto them.
			</Field.Description>
			<Field.Group>
				<form
					class="flex gap-2"
					onsubmit={(e) => {
						e.preventDefault();
						addTerm();
					}}
				>
					<Input
						placeholder="e.g. Kubernetes"
						bind:value={newTerm}
					/>
					<Button type="submit" variant="outline">
						<PlusIcon class="size-4" /> Add
					</Button>
				</form>

				{#if dictionary.length > 0}
					<ul class="flex flex-wrap gap-2">
						{#each dictionary as term (term)}
							<li
								class="bg-muted/40 flex items-center gap-1 rounded-md border py-1 pr-1 pl-3 text-sm"
							>
								<span>{term}</span>
								<Button
									variant="ghost"
									size="icon"
									class="size-5"
									aria-label="Remove {term}"
									onclick={() => removeTerm(term)}
								>
									<XIcon class="size-3.5" />
								</Button>
							</li>
						{/each}
					</ul>
				{:else}
					<Field.Description>
						No terms yet. Add the names and jargon you dictate often.
					</Field.Description>
				{/if}
			</Field.Group>
		</Field.Set>
	</Field.Group>
</Field.Set>

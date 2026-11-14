# Source-witness prescription ablation

Frozen before execution. This extends [the initial experiment](../2026-10-22-greenfield-models/RESULTS.md). Eight new read-only Claude Opus 5.5 high sessions: two skills × frozen old/revised versions × two repetitions. The generation prompt, output target (1600 words), source files, supporting instructions, launcher invocation, and global Claude instructions are held as in the prior file-editing runs. There are no resumes, previous answers, eventual solution, or preferred design in the run directories or prompts. Only the request sentence shown in [the exact diff](request-change.diff) is deleted.

The deletion removes both a mechanism (source witness) and its bundled no-silent-overwrite guarantee. This cannot isolate the mechanism's wording from that guarantee. It does not introduce a different requirement or hint toward a particular write policy. The remaining prompt still mentions conflict scenarios and gives API proposals, and the frozen historical source still implements guarded writes. It is an ablation of one explicit prescription, not an unanchored problem statement.

Each run has a fresh isolated Git root. Inputs were verified against the previous experiment's frozen file hashes. Within each new old/revised pair, only the skill treatment files differ. Across conditions for a given skill/version/repetition, only REQUEST.md differs, by exactly that deletion. Supporting rethink stays at baseline in both adversarial arms. Adversarial-review is tested as a delegated reviewer, not a panel. A/B identities are independently randomized per pair and held in the private manifest.

## Questions and criteria set before execution

1. Does a response independently develop a different, simpler organizing model, or mostly rearrange the existing buffer/storage model? Distinguish a concrete alternative from a passing suggestion.
2. What does the proposed saving operation promise under outside modification, deletion and newer local input? Which promises come from the request, and which does the response choose or inherit?
3. What machinery, concepts, coordination, or obligations disappear, and what work or loss is introduced? Removing checks alone is not a quality score.
4. Are accepted-input retention, failure handling, revision-bounded save/flush, and the concrete vanilla/Svelte use coherent? Requirements still present must be respected or explicitly proposed for change.

No particular eventual solution is supplied to participants or blind judges. Guarded publication can remain the strongest design if grounded in the desired use; a simpler write policy must explain its consequences. Two repetitions per skill/version provide a small variability check, not statistical confidence. Comparison to the earlier batch is exploratory: the model responses are fresh, not replayed with deterministic seeds.

Fresh version-blind judges will compare old/revised answers per skill, reading the modified request and evidence but no skill versions or prior outcomes. They will assess model simplicity and quality separately. Afterward the coordinator will compare observed contracts with the prior batch and verify deciding quotes. Native JSON, sessions, actual models, denials, errors, exact inputs and results are retained. No production code or skill wording is changed.

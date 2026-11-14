# Old versus revised greenfield skills: results

The experiment does not demonstrate a consistent improvement in thinking from the rewrites. A fresh, version-blind Claude Opus 5.5 high judge preferred the old answer in three matched pairs, the revised answer in three, and called two ties. Both rethink comparisons reversed direction on the second repetition. Both adversarial comparisons had one preference and one tie. These are qualitative reviewer preferences, not objective scores or a statistically powered result. Slight leans inside a tie remain ties.

| Skill | Problem | Repetition 1 | Repetition 2 |
|---|---|---|---|
| rethink | file-editing | old (medium) | revised (low to medium) |
| rethink | photo-import | revised (low to medium) | old (medium) |
| adversarial-review | file-editing | old (low to medium) | tie (low) |
| adversarial-review | photo-import | revised (medium) | tie (low) |

## What ran

Sixteen new read-only Claude Opus 5.5 high sessions: two skills × two versions × two tasks × two repetitions. Four additional new sessions judged the four task/skill groups without version identities, skill texts, prior conversation, or an expected solution. The judge model was the same as the generation model, which is a limitation. Every session completed successfully; no reported permission denials or truncation. Native session IDs, actual models, full outputs and execution records are retained. Recorded native list-cost estimate: $10.89. Output target was 1600 words; answers ranged from 1598 to 1997 words, so the target was not strictly obeyed.

The original file-editing opening request was supplied verbatim after an environment note. That note mapped its historical absolute path to a frozen source snapshot and explained unavailable thread tools. No later discussion or eventual solution was supplied. The request's earlier referenced threads were unavailable: this is a controlled initial-proposal comparison, not a complete replay of that conversation. The old skill is the pre-edit canonical Git version at 686f7f75c297140cd937d826f05598f552bec94e, not the divergent worktree version originally loaded by that earlier chat.

Photo import is a synthetic held-out problem covering byte preservation, overlapping imports, removable sources, restart, provenance, preview failures and cancellation. Seat booking was deliberately excluded because it shaped the revised examples.

Each run had its own isolated Git root. Supporting skill Markdown was held at the recorded Git HEAD; rethink remained old in both adversarial arms to isolate adversarial-review's own effect. All eight pairwise input checks passed: only the intended skill and its changed example differed. All 1736 fingerprinted input files remained unchanged. This measures initial rethink output and the delegated-reviewer part of adversarial-review, not live dialectic or its full panel coordination.

## Substantive observations

- All eight file-editing answers retained witness-based guarded writes. None independently developed unconditional publication as an alternative. The prompt explicitly required a source witness, so retention alone is not a correctness failure. It does mean the motivating breakthrough was not reproduced in this test.
- Both versions could form coherent alternative models. On photo import, all eight answers separated content-addressed originals, provenance or sightings, durable intent, and derived work. Independent model formation was not unique to the rewrite.
- The differences that decided preferences were mainly operational: representing reverted text while an older save lands; bounding flush under continuous input; preserving versus conflating intent and provenance; handling concurrent overlap and cancellation; and whether fingerprint shortcuts silently weakened the byte-preservation guarantee.
- Important weaknesses appeared across versions. The blind photo reviewers noted that parsing metadata by content hash alone does not account clearly for source-specific sidecars. Their suggested runtime checks remain unexecuted.
- Some automated criticisms are debatable: recording a sighting before preservation is not inherently wrong if the meaning is explicit. Treat the preference counts as the reviewer outcomes, not proof that every rationale is correct. The photo rethink judge also speculated about cross-repetition style families; the actual version key does not establish those families. Only its independent per-pair verdicts are counted.

## Concrete-use checks

All eight file answers supplied Svelte examples: 15 components after splitting blocks at explicit author filename markers. Svelte 5.56.3 compiled them without executing generated code. Twelve compiled as written. Of the three failures, two were explicit ={...} placeholders and compiled after replacing only those holes with ={undefined}; one used an invalid {:else} branch inside an await block. Several valid components warned that an initial prop value was captured. No imported types, hypothetical APIs, mounted behavior, or persistence semantics were verified. The blind file judges received the original compiler results and correctly distinguished placeholders from structural errors.

## Judgment and next decision

Keep the conceptual direction provisional. The clearer instruction wording is not evidence that the models reliably produce better designs. This experiment supports neither a blanket improvement claim nor a conclusion that the rewrites are generally worse. It gives no reason to add a mandatory guarantee-removal ritual. No skill edits or reversions were made during evaluation.

A future discriminating test could hold the task outcome fixed while varying how strongly an engineering mechanism is stated in the opening request. That would help separate prompt anchoring from skill effects. It would be a new experiment rather than a reinterpretation of these runs. More repetitions and another model would be needed before generalizing.

## Evidence

- [Protocol and limits](PROTOCOL.md)
- [All complete answer pairs, labeled A/B](BLIND-PAIRS.md)
- [Original opening request](original-file-editing-request.md)
- [Photo-import request](photo-import-request.md)
- [Rethink, file-editing blind assessment](judge-rethink-file-editing.assessment.md)
- [Rethink, photo-import blind assessment](judge-rethink-photo-import.assessment.md)
- [Adversarial-review, file-editing blind assessment](judge-adversarial-review-file-editing.assessment.md)
- [Adversarial-review, photo-import blind assessment](judge-adversarial-review-photo-import.assessment.md)
- [Svelte syntax results](svelte-syntax-checks.json) and [placeholder-only follow-up](svelte-placeholder-followup.json)
- [Machine-readable results](results.json)

Frozen treatment files, historical source archive, global Claude guidance, input hashes, exact prompts, native results, execution metadata and the private version key are retained beside this report.

# Removing the source-witness prescription

## Finding

Removing the one sentence was not sufficient to make either skill independently leave the base-and-conflict model. All eight new answers retain local text, a stored base, conflict/divergence handling, and resolution before ordinary publication proceeds. None develops unconditional whole-file publication as an alternative. This narrows the explanation: the explicit sentence is not the only available anchor. It does not prove that it had no effect.

| Skill | Version | Original request: base/conflict model retained | Sentence removed: base/conflict model retained |
|---|---|---|---|
| rethink | old | 2/2 | 2/2 |
| rethink | revised | 2/2 | 2/2 |
| adversarial-review | old | 2/2 | 2/2 |
| adversarial-review | revised | 2/2 | 2/2 |

One revised rethink run makes a local structural simplification: conflict is derived from dirty text and the storage relationship; revert/rebase plus fast-forward replace a separate resolve operation. The blind judge called that a stronger structural simplification than merely flattening the API. It also found a contradiction in the definition of saved while an older write is in flight, and incomplete lifecycle expression. The write policy remains guarded. That is evidence of some design exploration within the inherited model, not a reliable discovery of the larger alternative.

## What changed

Exactly this sentence was deleted, with no replacement:

> Saving uses an observed source witness to avoid silently overwriting outside changes.

The source, common supporting skills, active old/revised skill snapshots, generation prompt, global Claude guidance, model, effort, and output target were held fixed from [the first experiment](../2026-10-22-greenfield-models/RESULTS.md). Every run started in a new isolated Git root with no resumed session, previous answers, desired solution, or live source access. The historical source still contains guards and the request still centers conflict scenarios and the proposed state API. This is not an outcome-only greenfield brief.

The removed sentence bundles a mechanism with a guarantee. The ablation does not distinguish their individual effects. Earlier referenced threads remain unavailable, as in the first batch. Two repetitions per skill/version are a small variability check, not statistical confidence.

All 1524 input files were verified against the parent batch. Across request conditions, only REQUEST.md changes by the exact sentence deletion; within new old/revised pairs, only the skill treatment files differ. Inputs remained unchanged during execution. The old skill is the pre-edit canonical Git version, not the divergent worktree version that the earlier conversation used.

## Blind quality comparisons

These preferences concern overall answer quality, not whether an answer picked any particular write policy. Two fresh version-blind judges read the modified task, source and randomized A/B outputs. Neither saw the prior outcomes, version key, skill texts, or the eventual solution. Both used the same model as generation, which limits independence of model taste.

| Skill | First repetition | Second repetition |
|---|---|---|
| rethink | revised (low confidence) | old (low; close to tie) |
| adversarial-review | revised (medium confidence) | old (low confidence) |

The result remains mixed: two preferences for old and two for revised. Deciding differences include whether saved/dirty accounts for a running older write, completeness of the save/flush contract, a source-backed accepted-input counterexample, and API/template inconsistencies. A reviewer preference is not an objective score or proof that every criticism is correct.

Both judges found most proposals to be rearrangements of existing responsibilities, plus a change to asynchronous acquisition. Async acquisition moves loading to the caller and adds handle leases; that same move appeared in the original-prescription batch, so it is not a new response to this deletion.

## Evidence of retained policy

- [rethink-file-editing-r1-A](rethink-file-editing-r1-A.answer.md), line 71: - **Base:** the stored content the text descends from. It is the guard for the next write.
- [rethink-file-editing-r1-B](rethink-file-editing-r1-B.answer.md), line 27: - **base**: the exact stored content the text last agreed with. That's either the first content read or the last save that landed. Every write is guarded against it (compare-and-swap).
- [rethink-file-editing-r2-A](rethink-file-editing-r2-A.answer.md), line 62: - **`base`**: the stored text this buffer last confirmed, from a read or from its own write landing. A guarded write expects storage to still hold `base`.
- [rethink-file-editing-r2-B](rethink-file-editing-r2-B.answer.md), line 171: - **`base`:** it defines dirty and conflict, and guards every write.
- [adversarial-review-file-editing-r1-A](adversarial-review-file-editing-r1-A.answer.md), line 47:   - A conflict is kept until a resolution sets a new base.
- [adversarial-review-file-editing-r1-B](adversarial-review-file-editing-r1-B.answer.md), line 50: - **Base:** the stored content that held input was derived from. Saves compare against it.
- [adversarial-review-file-editing-r2-A](adversarial-review-file-editing-r2-A.answer.md), line 35: - **Diverged:** storage no longer holds the base. Either a guarded write was refused, or a newer read differed from the base while the editor held edits or storage became non-text or missing. Autosave stops.
- [adversarial-review-file-editing-r2-B](adversarial-review-file-editing-r2-B.answer.md), line 108: | **Typing after a conflict** | Stays `conflict` because the base is still stale. Autosave is **paused** until `resolve`. `resolve('mine')` moves the base to theirs and does an ordinary save. | **Defect.** `schedule()` runs anyway (`:1162`). Each pause sends a save that is bound to fail, which clears the conflict error while it runs (`:847`) and then sets it again. The resolve alert flickers away, and `resolveConflict` returns `BUSY` during each attempt (`:1229-1233`). |

These quotations establish the chosen model and publication relationship. They do not establish correctness of a hypothetical implementation. No answer's proposed storage engine or lifecycle has been implemented.

## Checks and execution

8 generation sessions and 2 blind-judge sessions completed as 10 distinct native sessions. Actual model: claude-opus-5-5 at high effort. No errors or reported permission denials; generation stopped with end_turn. Native recorded list-cost estimate: $7.85. The target was 1600 words; actual answers ranged 1618 to 2086, so that target was not strictly followed.

The installed Svelte 5.56.3 compiler checked 12 generated components after separating explicit author filename markers. Ten compile as written; two use an invalid root-level {@const}. No hypothetical imported types, editor APIs, mounted lifecycle, or storage semantics were executed. The judges received these checks as limited concrete-use evidence.

No production code or live skill wording was edited during this experiment.

## Interpretation

The evidence does not validate a stronger wording prescription for either skill. A plausible remaining anchor is the whole task framing: the proposal already contains conflict states, the central question asks how to organize them, and the implementation makes a base necessary for its existing write semantics. Both versions repeatedly take that account forward even after its explicit prescription is removed. That is a hypothesis supported by the pattern, not an isolated causal result.

The original conversation also supplied later product judgment about accepting races and replacement. Removing the witness sentence supplies none of that judgment. There is a difference between being permitted to question a guarantee and learning that its loss is acceptable. An agent could still surface the tradeoff independently; these runs did not develop that alternative.

The next discriminating test would be an outcome-only first pass without the state proposal or implementation, followed by a second pass against real callers. That would help distinguish source/framing anchoring from a general preference for guarded editing. It was not run here.

## Full records

- [Protocol](PROTOCOL.md)
- [Exact request change](request-change.diff)
- [Modified request](request-after.md)
- [All complete A/B outputs](BLIND-PAIRS.md)
- [Rethink blind assessment](judge-rethink-file-editing.assessment.md)
- [Adversarial-review blind assessment](judge-adversarial-review-file-editing.assessment.md)
- [Machine-readable results and policy quotations](results.json)
- [Input isolation check](input-isolation-check.json) and [stability check](input-stability-check.json)
- [Svelte syntax checks](svelte-syntax-checks.json)

Exact generation/judge prompts, source fingerprints, native results, actual model usage, session IDs and the private version key are retained beside this report. The parent experiment retains the frozen skill versions and historical source archive.

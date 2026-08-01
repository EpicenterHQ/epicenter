# 0195. Vocab is a Chinese companion, and one app serves one learning goal

- **Status:** Proposed
- **Date:** 2026-08-01
- **Amends:** [ADR-0105](0105-vocab-is-a-multilingual-tutor-and-readings-are-a-client-side-derived-view.md), withdrawing the language-blind tutor, the multi-script reading registry, and the three-category script taxonomy. ADR-0105's decision that readings are a deterministic, offline, client-side derived view over clean text stands unchanged and is the reason this is an amendment rather than a replacement.
- **Relates:** [ADR-0102](0102-vocab-stores-verbatim-entries-under-a-human-owned-note-and-refuses-glosses-srs-and-provenance.md) (the no-language-column refusal, now moot rather than merely upheld)

## Context

ADR-0105 repositioned Vocab as a general multilingual tutor: one language-blind
system prompt that infers the studied language from the conversation, plus an
ordered registry of per-script deterministic romanizers, of which `pinyin-pro`
was the flagship and `wanakana` and `transliteration` the other two shipped
providers. That design was correct for a container serving many learning goals.

The product destination is not that container. It is one Chinese conversation
companion with mixed Chinese-English tutoring. Holding the multilingual shape
costs more than the machinery it carries: the tutor prompt, the entry-candidate
prompt, and the practice compiler each go out of their way to hold no
language-specific string, which makes each of them vaguer than it could be. It
also forecloses the one capability the commitment buys. Chinese writes no word
boundaries, so locating a saved multi-character phrase inside a passage is exact
longest-match substring search with no false-positive class; a language-blind
matcher would need per-language boundary and inflection rules before it could
find anything.

## Decision

**Vocab is a Chinese companion. The tutor teaches Chinese in English, the reading
overlay is Mandarin pinyin over Han, and there is exactly one romanizer. One app
serves one learning goal; a second learning goal is a second app, never a language
field, a profile, or a provider registry.**

- One tutor system prompt, explicitly Chinese and English. English carries
  explanation and meta-commentary; Chinese carries vocabulary, examples, and
  conversational lines. The instruction to infer and follow the studied language
  is deleted.
- One romanizer, built on a statically imported `pinyin-pro`. The provider type,
  the ordered registry, the script-detection dispatch, the load cache, the
  composer, and the `wanakana` and `transliteration` providers and dependencies
  are deleted.
- The Chinese romanizer no longer abstains on kana or hangul. That guard existed
  so Han shared with Japanese was never stamped with a Mandarin reading; in an app
  that is Chinese by construction, the Mandarin reading of a Han run is the correct
  answer.
- Every prompt may name Chinese directly. Language neutrality is no longer a
  constraint on any prompt Vocab composes.
- ADR-0102's refusal of a `language` column stands and is now moot: there is one
  language, so the column would be a constant.

## Consequences

- The reading overlay stays deterministic, offline, and free of any model call,
  which is ADR-0105's local-first payoff and the reason `pinyin-pro` remains
  load-bearing. Saved transcripts still read with no backend.
- The failure mode inverts in one narrow case. Under ADR-0105 a missing reading
  was always safe; with the abstention guard gone, Japanese text pasted into a
  Chinese conversation renders Mandarin readings over its kanji. This is accepted
  as off-domain input in a Chinese app, and restoring the guard is one regex if it
  proves annoying.
- Longest-match phrase matching over saved entries becomes correct rather than
  approximate, which is what unlocks entry highlighting in the transcript and
  derived conversation rosters.
- Serving a second language now requires a second app rather than a provider file
  plus a registry line. That is the deliberate trade: ADR-0105's "how to add a
  language" procedure is withdrawn.
- The app, package, and Lens namespace keep the name `vocab`. Directory and
  package names are cosmetic; the namespace `so.epicenter.vocab` is the replica
  identity and is not renamed as part of this decision.

## Considered alternatives

- **Keep the multilingual tutor and add a Chinese profile.** Rejected: it retains
  every piece of machinery this deletes and adds a profile concept above it, while
  still forbidding a correct phrase matcher.
- **Keep the registry with one provider in it.** Rejected: a registry with a single
  permanent entry is dispatch with nothing to dispatch on, and it advertises an
  extension point the product no longer wants used.
- **Rename the app and namespace to something Chinese-specific.** Rejected here:
  the namespace is the replica identity, and changing it strands local data for a
  cosmetic gain. Reopen it as a deliberate replica break if ever wanted.

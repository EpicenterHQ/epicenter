# 0446. Vocab teaches English without automatic pronunciation readings

- **Status:** Proposed
- **Date:** 2026-09-24
- **Supersedes:** [ADR-0105](0105-vocab-is-a-multilingual-tutor-and-readings-are-a-client-side-derived-view.md) (Vocab's multilingual tutor and automatic reading overlay)
- **Unbuilt:** Vocab still uses a multilingual system prompt, the reading overlay, and `showReadings`.

## Context

`VOCAB_SYSTEM_PROMPT` currently infers a studied language and asks the tutor to mix that language with English. Settled answers pass through `ReadingMarkdown.svelte`, which adds pinyin over Han, romaji over kana, and Latin transliteration over Cyrillic. The device-local `showReadings` setting defaults on. ADR-0105 chose that design when Vocab was a multilingual tutor.

The product now has a narrower job: help a learner understand unfamiliar English words and phrases, save chosen expressions, and practice using them. A future Chinese or other-language teaching app owns its own instructional flow. Automatic script readings do not serve Vocab's English vocabulary job.

## Decision

**Vocab teaches English vocabulary and does not annotate answers with automatic pronunciation readings.** Its tutor prompt, answer copy, entry suggestions, and Practice request speak about English as the studied language. The tutor may explain pronunciation when asked; it does not claim that a reading overlay will supply it. The saved entry remains the learner's chosen text with a human-owned note and stage.

Vocab removes `showReadings` from its Local definition and UI. It removes its reading registry, providers, wrapper component, script libraries, and ruby-specific selection cleanup. Settled answers use plain Markdown rendering. Shared Markdown's reading seam is assessed against remaining callers and retired if none uses it. Vocab does not add a target-language setting or share its entry pool with a future language-specific app through this change.

## Consequences

English explanations and examples no longer inherit multilingual prompt behavior. A learner who needs pronunciation asks the tutor; no automatic phonetic hint appears above text. Removing the preference avoids a new Personal setting and removes a device setting that otherwise crosses accounts.

Other language apps can make their own decisions about script, pronunciation, curriculum, and saved data. This decision does not create one of those apps or define its name or schema.

## Considered alternatives

- Default `showReadings` to false: keeps the full provider and UI family for a hidden convenience.
- Keep Vocab multilingual: retains language inference, mixed-language answers, and the reading overlay in a product now assigned the English vocabulary job.

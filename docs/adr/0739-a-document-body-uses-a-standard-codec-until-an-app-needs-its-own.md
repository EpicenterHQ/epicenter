# 0739. A document body uses a standard codec until an app needs its own

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md) at "A document contract carries … a body whose type is the app's own": a body uses one of three standard codecs; [ADR-0727](0727-json-schema-is-the-field-language.md) at "a field is a key in the item's map": a field is a key in the item's `fields` map.
- **Relates:** [ADR-0707](0707-an-app-that-needs-co-editing-is-a-document-app.md) (co-editing apps are document apps), [ADR-0724](0724-a-browser-extension-keeps-its-data-in-a-document.md) (Tabs keeps its data in a document).
- **Unbuilt:** all of the document store ([ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md)), including the item map and the three codecs.

## Context

[ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md) lets a document
contract give an item a body "whose type is the app's own", which must
convert to Markdown and back for export.
[ADR-0727](0727-json-schema-is-the-field-language.md) made each field a key
in the item's map and left the body undecided: "An item's body is not a
field; how a document stores a body is decided separately."

A body type of each app's own means each app writes a converter to Markdown
and back, and Epicenter's generic views can show no body they do not know.
Tabs, the first document app, has no body at all.

## Decision

**A document item is a Yjs map with two keys, `fields` and `body`.**

```txt
item: Y.Map
  fields: Y.Map       one key per contract field (ADR-0727)
  body:   by codec    absent for none
```

**A collection's body uses one of three standard codecs:**

| Codec | `body` holds | Exports as |
| --- | --- | --- |
| `none` | nothing; the key is absent | a note with front matter only |
| `markdown` | a `Y.Text` of Markdown source | the text, unchanged |
| `rich` | a `Y.XmlFragment` in one schema Epicenter publishes | Markdown converted from the fragment |

**An app gets a codec of its own only when one of these cannot hold its
body,** decided by a later record that names the app and its body.

## Consequences

- Epicenter's generic views and `epicenter get` show every body, because
  there are three kinds.
- Export to Markdown and import back are written three times, not once per
  app.
- A `rich` body loses what Markdown cannot express when exported.
- Fields and body never share a key space, so a field named `body` cannot
  collide with the body.

## Considered alternatives

- **A body type of each app's own (ADR-0705).** A converter per app, and no
  generic view of a body.
- **Fields as top-level keys beside `body`.** A field could not be named
  `body`, and adding a reserved key later would collide with fields already
  stored.
- **Markdown only.** A co-editing app with headings, lists, and marks would
  merge structure as text, which Yjs merges per character.

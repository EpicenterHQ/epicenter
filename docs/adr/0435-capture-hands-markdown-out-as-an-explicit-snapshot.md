# 0435. Capture hands Markdown out as an explicit snapshot

- **Status:** Proposed
- **Date:** 2026-09-23
- **Unbuilt:** Capture-and-thought Markdown preview, clipboard delivery, and download.

## Context

Capture holds dated writing and thoughts that a person may later incorporate into Markdown files. Successful transfer cannot establish that they used everything. Live file editing and two-way synchronization would give this inbox a second storage owner.

## Decision

Offer **Copy as Markdown** for one capture and all of its currently visible thoughts in manual order. Offer **Download Markdown** using the same bytes when a file is useful. Preview the included capture text, thought count, thought text, and order before delivery. Take one synchronous snapshot of that material before clipboard or download work begins. An unavailable thought shown in recovery can be copied on its own; it is not silently included under a missing capture.

The first format keeps the capture's full text and every thought's full text. It separates them so an authored heading, list, blank line, or code fence inside one body cannot consume the next item. It does not truncate long bodies, drop empty ones, or infer an event date from the content. The capture time can appear as context in the output. The output is readable Markdown, not a promised round-trip import format. The first release needs one clear format; user-defined templates, regex extraction, live Markdown tools, and file placement are later product questions.

Copy and download operate on the reviewed snapshot. Later edits or reorders remain in Capture and require a fresh copy. Clipboard failure leaves the snapshot available for retry. Starting a browser download is not proof that the file was saved or incorporated. Neither action changes the store.

The person incorporates the material in their Markdown editor. They may then invoke a separate delete action with a fresh preview under [ADR-0434](0434-capture-keeps-unavailable-thoughts-visible.md). No success callback deletes, archives, or marks captures or thoughts as processed. No destination-file link is persisted. Deletion in Capture never opens or changes the Markdown file.

## Consequences

Any Markdown editor can receive the material without a Capture connector. The person decides when integration is complete. The first release does not offer live tool access, automatic file placement, or two-way file synchronization. A capture is a dated context with an ordered list, so the handoff needs no recursive traversal, depth-dependent headings, parent paths, or arbitrary-depth identity metadata.

The generic store artifact exporter and checkout machinery remain available for their own purposes. They do not define this selected-capture product workflow.

## Considered alternatives

- **Live Markdown tools reading captures:** Requires an authenticated discovery and lifetime boundary before delivering this workflow.
- **A writable checkout:** Introduces conflict resolution with a second editable copy.
- **Export success followed by automatic deletion:** Mistakes transfer for the person's decision that integration is complete.
- **User-defined templates or regex rules in the first release:** Adds a second product for transforming content before the basic handoff is proven useful.

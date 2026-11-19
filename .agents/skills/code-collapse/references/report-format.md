# Collapse pass reports

Scale the report to the work. A routine pass needs the concrete simplifications,
why they helped, verification results, and any remaining consequential decision.
Do not require export counts or a checkpoint transcript for a local cleanup.

For a longer campaign, preserve enough evidence to resume without repeating work:

- Changes made, grouped by logical simplification; include commit IDs if committed.
- What disappeared and where the remaining behavior now lives.
- Checks run and results, including unresolved failures and whether baseline
  attribution was verified.
- Deferred findings and the decision or evidence needed to act.
- Important rejected candidates and why their boundaries earn their place.
- Working tree or isolated checkout state when relevant to handoff.

Include export and file-count deltas when they help judge the campaign or the
user requests them. Report only measured changes. During execution, explain
meaningful findings and scope expansion in short updates; do not print a fixed
block after every rejected candidate.

# Could the same job use fewer concepts?

Understand what the system needs to do and follow actual callers. Then step
back: could it do the same job with a simpler model? A collection of reasonable
parts can still ask someone to understand too much.

Make that question concrete by visibly enumerating the surface someone must
understand to use or change the relevant workflow, API, or subsystem. Include
nouns such as types, objects, services, and stores, and inspect their methods,
properties, object keys, options, and state variants. Group members by owner;
explain what each represents or does and why it exists separately. Trace actual
callers and state transitions rather than relying on declarations alone. Reuse
an inventory already developed during the work. Stay within the relevant
surface rather than cataloging every transitive library member.

Challenge the distinctions together, including distinctions within one object.
Which nouns describe the same thing, methods perform the same operation,
properties duplicate information, or keys maintain relationships that ownership
could determine? Could a different design make several unnecessary at once?
For example, `status` and `isSaving` may repeat one fact, while `savedTitle` and
`draftTitle` preserve different information during editing. `save()` and
`submit()` may forward the same operation or represent different workflows.
Establish which case callers require before collapsing them.

Show the simpler design through a real caller or interaction, and check that it
still does what matters. Use
[rethink](../../rethink/SKILL.md) when this changes ownership, lifecycle, APIs,
or package boundaries.

Show the methods, concepts, and relationships before and after (current and
proposed for a review), what disappears, and where its information and
responsibilities go.
Explain why the remaining distinctions matter. A rename or move may be the
right repair, and keeping the model is valid when the alternative makes things
harder.

Count what someone must understand. Names and members are evidence of concepts,
not a one-to-one count: deleting a type does not remove a concept that callers
still need. Hiding several concepts inside one object, renaming methods, or
replacing distinct operations with a generic method and flags does not by
itself simplify the model. Compare counts on the same basis and explain
uncertainty. A focused local transformation needs no subsystem inventory.

## Follow broad names into the structure

Use broad names such as `context`, `manager`, and `service` as starting points
for structural investigation. Ask what the name leaves unexplained: what
belongs together, who owns the work, and why callers need this object.
Sometimes that investigation earns a more precise name. Follow it further when
it reveals responsibilities split across layers, dependencies passed through
intermediaries, or coordination that a different design could eliminate.
Develop that alternative far enough to show what becomes simpler and what
responsibilities remain.

Pursue the strongest structural simplification the evidence supports. Trace the
suspicious object through its construction, callers, state, and cleanup. Map
how responsibilities and information move across the surrounding system,
including which layers forward work and which decisions several owners repeat.
Ask what makes that arrangement necessary, then develop an alternative that
could make several parts unnecessary together. Before settling for a rename or
local cleanup, explain whether a deeper change would simplify the whole
workflow. Compare concrete caller code, ownership, lifetimes, and the complexity
introduced as well as removed.

Carry out this investigation independently. Bring the user a developed
alternative and the consequences that require their judgment. Ask when a
missing requirement or product choice would materially change the direction;
resolve questions about the existing implementation through inspection.
Keep changes within the task's authorized scope. A focused local transformation
needs no subsystem inventory.

## Replace unnecessary flexibility with stronger invariants

Look for stronger invariants that make independently maintained relationships
unnecessary. What determines what, how many things can belong to each owner,
and for how long? If actual use supports one resource per owner, one selection
per lifetime, or one identity for two concepts, ask whether construction,
containment, or derivation can replace mappings, identifiers, switching, and
synchronization. Name the behavior the stronger rule would disallow and the
machinery it removes. Preserve useful sharing and genuinely different
information; one-to-one pairing alone does not justify merging concepts.
Count the independent choices and coordination eliminated, rather than
treating fewer maps as the goal.

Identify where the stronger invariant is established and enforced; explain
which downstream decisions become unnecessary because callers can rely on it.

For example, could each editor window edit one folder for its lifetime?
Handles and operations in that window could inherit the choice instead of
selecting folders independently. Page-level root IDs, per-call folder
selection, and folder switching could disappear. Another folder would open
another window. A folder could still have several windows or views: each
window determining one folder does not require a folder to have only one
window. A native window-to-folder binding may still be needed to record the
actual choice; the invariant removes the independent choices around it.

Ownership and lifetime can reveal these opportunities, but the current
relationships are candidates too. Changing them may simplify the whole model.
Do not merely hide the same independently variable relationships inside one
object, or remove a real workflow to obtain a cleaner count.

## Example: a hypothetical profile editor

Suppose inspection finds these five named abstractions:

| Noun | What it represents and owns |
|---|---|
| `SavedProfile` | The accepted profile |
| `ProfileDraft` | The person's unfinished edits |
| `ProfileFormState` | A synchronized copy of those edits, plus derived validation |
| `ProfilePayload` | Another stored copy, prepared for saving |
| `ProfileController` | A forwarding layer for field changes and submission |

Try keeping the saved profile and draft, deriving validation, constructing the
request when submitting, and putting forwarding work at its callers. This
removes two synchronized copies and a forwarding layer. Keep saved and draft
separate because unfinished edits can differ from accepted data.

Test typing and saving. If someone keeps typing during a save, the submitted
version may also need to remain distinct. That concept stays even if it becomes
a local variable. Five named abstractions becoming two does not establish that
only two concepts remain. Account for any other work, such as cancellation,
before deleting the part that owns it.

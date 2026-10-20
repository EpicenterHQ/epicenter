# Could the same job use fewer concepts?

Understand what the system needs to do and follow actual callers. Then step
back: could it do the same job with a simpler model? A collection of reasonable
parts can still ask someone to understand too much.

Make that question concrete by visibly listing the methods and enumerating and
counting the concepts someone must understand to use or change the workflow,
API, or subsystem.
Types, objects, services, stores, modes, and lifecycle states are candidates.
Explain what each does or represents in one sentence and why it exists
separately. Reuse a list already developed during the work.

Challenge the distinctions together. Which parts describe the same thing,
duplicate information, or exist to keep other parts in sync? Could a different
design make several unnecessary at once? Show the simpler design through a
real caller or interaction, and check that it still does what matters. Use
[rethink](../../rethink/SKILL.md) when this changes ownership, lifecycle, APIs,
or package boundaries.

Show the methods and concepts before and after (current and proposed for a
review), what disappears, and where its information and responsibilities go.
Explain why the remaining distinctions matter. A rename or move may be the
right repair, and keeping the model is valid when the alternative makes things
harder.

Count what someone must understand. Deleting a type does not remove a concept
that callers still need; hiding several concepts inside one object does not
make them one. Compare counts on the same basis and explain uncertainty. A
focused local transformation needs no subsystem inventory.

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

# Radical options

Use these moves to find alternatives the current framing hides.

## Question shared premises

Name what the options you're weighing take for granted. Ask whether those
assumptions follow from the purpose or from earlier design choices, and
what would become possible if we changed them.

For example, locking a handle during updates and queuing changes until
it's idle both assume the handle must survive the setting change.
Questioning that premise opens up restarting the app with the new setting.

## Trace where the requirement comes from

Follow the requirement through its callers, the lifetimes it depends on,
and the surrounding system. Find out who relies on it and which decisions
created that dependency.

If other code holds the handle, ask whether that code must also survive
the setting change. Reloading could recreate the handle and its consumers
together. Work in progress might still need to survive. The trace shows
what the requirement protects and what changing it would affect.

## Mentally inline suspicious helpers

Imagine a helper's body written directly into its callers. Examine the
work that remains once its name is gone. Look for operations the system
already performs elsewhere, or responsibilities that could be composed
differently.

Also notice behavior the helper genuinely owns, such as managing work
already in flight. Use what you find to reconsider where the boundary
belongs.

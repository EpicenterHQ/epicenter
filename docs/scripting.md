# Scripting

Epicenter has no generic background watcher or off-process action bus. A script
that reads or changes application records owns an Epicenter replica for its
process, binds the application's Lens, calls the application's domain service,
and disposes the replica when the workflow finishes.

This keeps the important boundaries explicit:

```txt
script
  -> opens one replica owner
  -> binds the application Lens
  -> calls an app-owned workflow
  -> disposes the owner
```

Do not add a generic CLI command that accepts arbitrary action names. Such a
command would need to own schemas, authorization, concurrency, error mapping,
and a long-lived process protocol without a concrete product workflow to
justify them.

Use the existing CLI only for its two independent tool families:

- `epicenter auth` manages the machine session.
- `epicenter matter check` validates typed Markdown whose source of truth is on
  disk.

For application automation, add an app-specific command or script. Parse the
workflow's real inputs, open the appropriate Epicenter adapter, bind the same
Lens as the application, invoke the domain operation, and exit. This makes the
script's data ownership and failure semantics the same as any other host.

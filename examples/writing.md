# Share the writing app

`writing/` is generated code exported from the Writing app maintained in an
Epicenter. Its notes stay in that Epicenter's private `apps/writing/data/`.
The exported files use the same `new --from` path as any other shared app.
There is no named template or bundled writing app in the CLI.

To refresh this code after changing the maintained app, export it from your
private Epicenter. Export saves a local checkpoint before copying code:

```sh
epicenter export writing "$REPOSITORY/examples/writing"
```

Replace `REPOSITORY` with the path to this checkout. Export replaces every
generated file in `writing/`; keep handwritten publication files outside it.
Review the result, then commit and publish the code with Git. Do not put notes
or credentials into this directory.

After these files are published, a developer can take their own copy:

```sh
epicenter new writing --from EpicenterHQ/epicenter/examples/writing
```

Each recipient owns their copy and its records. Source changes are compared
and adapted deliberately; refreshing this export does not update their apps.

# Exhaustive union handling

## Find switches that should cover every case

If you are reviewing a directory, start by finding its switches. For example:

```sh
rg -n '\bswitch\b' apps/whispering/packages/recorder/src
```

For each relevant switch, follow the value to its type. If the type
lists every possible case and the switch is responsible for all of
them, give each case an explicit branch and end with
`default: value satisfies never`. A case can explicitly do nothing.

If the value can contain arbitrary input, decide how the switch
should handle unfamiliar values.

## Recorder refusals

The desktop shell's recorder declares its refusals as a union in the
generated [bindings](../../../../apps/whispering/packages/recorder/src/native/bindings.gen.ts).
[fromNative](../../../../apps/whispering/packages/recorder/src/tauri.ts)
maps each one to the package's own `RecorderError`, gives every name a
branch, and ends with

```ts
default:
  return RecorderError.Failed({ cause: error satisfies never });
```

Add a refusal in Rust and regenerate the bindings, and TypeScript flags
this line until `fromNative` handles it.

The value can still hold a reply the type does not list. Tauri rejects a
command the window has no permission for with its own error, before the
recorder answers. So the `default` also reports that reply as a failure.
Keep that fallback: the type describes the shell, not everything `invoke`
can return.

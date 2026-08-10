<!--
Nothing below is required. These are the sections the merged pull requests here
tend to have, offered so you don't have to reverse-engineer them. Delete any
that don't apply, rename them to say what you actually found, and write prose
rather than filling in fields.
-->

## What this is

What changes, and `Closes #123` if there's an issue. If someone reported it,
say who and where.

## Mechanism

Why the old behaviour happened — the specific line, default or assumption
responsible — rather than what you did about it. If you measured something,
paste the numbers.

## Scope

What you deliberately left alone, and why. Anything you noticed while working
and chose not to fix here belongs in this section too.

## Tests

What you added or changed. For a fix: revert the fix, keep the test, and say
whether it goes red. A test that passes either way isn't testing the fix.

If the test matches source text rather than running the code, say what the
anchor is. Pinning a contract the compiler can't check — a Tauri command name,
an i18n key, a second copy of a fixed behaviour — is what those are for.
Pinning an internal call site pins today's spelling instead, so it goes red on
a rename that broke nothing and stays green on a change that broke something.

Not every fix needs one. A defect that announces itself — a crash, a type
error, something the next person to open the app would see — is already caught
by `npm run check`, `cargo test` and a single manual run.

## Verification

The commands you ran and what they said — the ones CI runs are:

```
npm audit
npm run check
npm test
cargo test        # in src-tauri/
```

And what you *didn't* verify: platforms you couldn't try, paths you reasoned
about rather than ran. That's more useful to a reviewer than a list with no
gaps in it.

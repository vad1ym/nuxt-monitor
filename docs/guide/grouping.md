# Grouping

A thousand occurrences of one bug should be one row you can act on, not a
thousand rows you page past. Occurrences are grouped into **issues** by a
fingerprint built from four things:

1. **Side** — client or server.
2. **Error type** — `TypeError`, `RangeError`, and so on.
3. **The normalised message.**
4. **The topmost stack frame that belongs to your application.**

## Why the message is normalised

A message usually carries the very thing that differs between occurrences:

```
User 41827 not found
User 90113 not found
```

Grouped literally, those are two issues; after a busy day, thousands. So
volatile fragments are replaced before hashing:

| In the message | Becomes |
| --- | --- |
| `550e8400-e29b-41d4-a716-446655440000` | `<uuid>` |
| A hex run of 16 characters or more | `<hash>` |
| `'anything quoted'` or `"anything quoted"` | `<str>` |
| A bare number | `<n>` |

Both messages above normalise to `User <n> not found` and land in one issue.

Each occurrence keeps its own text, so the issue page still shows you the real
ids. Before that was true, every occurrence borrowed the issue's message — the
*most recent* one — and all 250 rows showed the same id.

## Why the frame must be yours

The same bug surfaces through different library frames depending on the call
path. Grouping on the topmost frame of all would scatter one fault across many
issues, keyed by whichever internal function happened to be on the stack.

So frames inside `node_modules`, `node:internal`, the Nuxt and Vue runtimes,
and Nitro's chunks are skipped, and the first frame in your own code is used.

## When grouping is wrong

**Too coarse** — distinct faults collapsing into one issue. Usually two
different errors with the same generic message thrown from the same helper. The
fix is a more specific message.

**Too fine** — one fault spread across many issues. Usually a message carrying
something normalisation does not recognise, like `failed for widget kx91#a`.
Move the variable part out of the message and into context.

That second case is worth watching for, because it is the axis along which the
database actually grows: every occurrence gets its own fingerprint, so 20,000
such errors become 20,000 issues. `maxIssues` and `maxDatabaseMb` bound it —
see [Storage](./storage).

## What a grouped issue tells you

Once occurrences are one issue, they can be counted against what they share —
browser, browser version, OS, OS version, device, release, route and session.

![The same issue broken down by browser, browser version, OS and OS version, each as a ranked bar with percentages](/media/breakdown.png)

"250 errors" is a number; "250 errors, all Safari 16" is a diagnosis. Clicking
a slice filters the occurrences below it.

## Resolving

Marking an issue resolved hides it from the default view. If it happens again,
it reopens automatically — a resolved issue that recurs is not resolved.

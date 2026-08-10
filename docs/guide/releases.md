# Releases

"When did this start?" is the first question of any incident. A release stamped
on every event answers it directly — *appeared in 1.4.0* rather than a
timestamp somebody has to match against a deploy log.

## Setting one

```ts
monitor: { release: process.env.npm_package_version }
```

It is read at **build time**, so the value describes the build it is stamped
into rather than whatever the server process happens to see later.

If you set nothing, the module falls back to whatever the platform already
knows:

1. `NUXT_MONITOR_RELEASE`
2. `GITHUB_SHA`
3. `VERCEL_GIT_COMMIT_SHA`
4. `CF_PAGES_COMMIT_SHA`
5. `COMMIT_REF`

A commit SHA is not a friendly version, but it is unambiguous and it is there
for free — the alternative is an empty facet. Full 40-character SHAs are
shortened to seven, which identify a commit perfectly well and are readable in
a filter list.

::: warning A release set on the server overrides the client's
`NUXT_MONITOR_RELEASE` in the server environment applies to client events too. If
you are deliberately reporting different releases from browser and server, do
not set it at runtime.
:::

## What you get for it

**The Releases screen** lists each release with its issue count, its event
count, and how many issues *first appeared* in it. That last column is the one
worth reading after a deploy: it separates "this release is noisy" from "this
release introduced something new".

**Filtering.** Clicking a release narrows the issue list to it. Every issue
breakdown also counts by release, so an issue that only happens on one version
says so on its own page.

Sourcemaps survive a deploy whether or not you set a release — the archive is
keyed by build, not by release name. See
[Sourcemaps](./sourcemaps#across-deploys).

## Suggested value

Whatever you can recover later from the release string alone. A version from
`package.json` is readable; a commit SHA is precise; both are better than
nothing.

```ts
// Readable, and enough to find the tag.
release: process.env.npm_package_version

// Precise, free in CI.
release: process.env.GITHUB_SHA

// Both.
release: `${process.env.npm_package_version}+${(process.env.GITHUB_SHA ?? '').slice(0, 7)}`
```

Release strings are limited to 64 characters. A release arriving on a client
event comes through unauthenticated ingest, so it is treated as untrusted text
throughout — it is a label to read and filter by, never a path.

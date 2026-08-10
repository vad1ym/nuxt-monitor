# Sourcemaps

A minified frame reading `nitro.mjs:6416` tells you nothing. The whole point of
this module is that the frame instead reads `server/api/orders.ts:42` with the
failing line shown around it — and it manages that without an upload step,
because it runs on the machine that holds the maps.

![A client TypeError resolved to client-error.vue line 33, showing the failing line in context with six Vue frames collapsed](/media/issue.png)

Framework frames are folded away, because they are never what you are looking
for.

## How it works

Maps are read from disk at the moment you open an issue, not at capture time.
An error storm would otherwise turn into a burst of map parsing on the request
path.

**Client maps** are generated as `sourcemap.client: 'hidden'` — the files are
written but no `sourceMappingURL` comment points at them — and then moved out
of the public directory into `.output/monitor/maps` after the build. `'hidden'`
alone is not enough: Nitro would still serve the `.map` file to anyone who
guessed its name.

**Server maps** sit beside their code in `.output/server`, and need two
settings that the module applies for you. Each fails silently on its own:

- `sourcemap.server` defaults to `false`, so no usable map is written.
- Nitro's `sourcemapMinify` blanks the `mappings` of any map whose `sources`
  mention `node_modules` — a reasonable size optimisation when nobody reads
  the maps. But the server bundle mixes your handlers with vendor code in one
  chunk, so the rule catches your code too. The `.map` still exists and still
  names your files, which is what makes it so quiet: the resolver finds a map,
  parses it happily, and gets `null` for every position.

Both are only set when you have not said otherwise, so opting back into
smaller maps stays possible.

## Across deploys

A deploy replaces the build output, and with it the maps that explain the
traces still arriving from the version being replaced. That is exactly the
window where you need them.

So every build files a copy of its maps beside the database, under an id
derived from what it produced:

```
.monitor/
  monitor.db
  maps/
    90d1cd9e2f3d/
    1366f5a7c0c7/
    …
```

Resolution then searches the running build first and every archived one after
it. That is safe — and it is why the archive is keyed this way — because a
bundler's asset names carry a content hash: `eH5xbD7-.js` names one build's
output and nothing else. Measured on consecutive builds of the example:
fourteen assets each, zero shared names.

::: warning Not keyed by release, and this matters
A release name does not identify a build. `dev` is reused on every rebuild, and
a tag gets built again after a failed deploy. An archive keyed by release meant
the second build deleted the first one's maps — and every event already
recorded against it lost its source permanently, which is the exact failure the
archive exists to prevent.
:::

`keepSourcemapsFor` bounds the archive at five builds. Maps are large and
deploys are frequent, so an unbounded archive is a directory that only grows on
the same disk as your database.

The archive does not need `release` set. A release is still worth setting — it
is what tells you *when* something started — but map resolution no longer
depends on it.

## In development

There are no maps on disk in dev — Vite serves each module transformed with its
map inlined as a base64 comment, and the browser reports frames against exactly
those URLs. So the module fetches the module back from the dev server it came
from and reads the inlined map.

Fetching is restricted to loopback addresses and to the `/_nuxt/` path Vite
serves modules under. Client stacks arrive through an endpoint that needs no
credentials, so an unchecked fetch here would be a request to any address the
process can reach, chosen by whoever posted the stack.

When that fetch comes back empty the archive is still searched, which covers a
case that looks like a bug until you know it: a dev server reads the same
database as the production build beside it, so the issues on its dashboard are
often not from the process displaying them. Their frames name hashed assets
Vite never served, the fetch 404s — and the map is on disk in the archive.

::: info Server-side traces in dev
Server frames from a dev server resolve less reliably: Vite serves only the
client transform over HTTP. Production server traces resolve properly.
:::

## When a frame does not resolve

The dashboard distinguishes two failures, because they send you to different
places:

- **`no map`** — no sourcemap for that file was found anywhere. The event
  almost always came from a build this process cannot see.
- **`unmapped`** — a map was found and read, and it covers no position at that
  point. Ordinary for a frame inside vendor code.

In both cases the line number shown counts lines in the built bundle, not in
the file named beside it.

## They are never published

Two things keep the maps private:

- `'hidden'` leaves no `sourceMappingURL` comment in the served bundle, so
  nothing points a browser at them.
- They are moved out of the public directory before the manifest is built, so
  requesting one is a plain `404` rather than an error that would confirm the
  file once existed.

## Untrusted frames

A client stack names a file, and that name is chosen by whoever posted it.
Client frames may therefore only resolve against the published build assets —
never an arbitrary path on disk.

A frame spelling itself `/_nuxt/../../../../etc/passwd` used to resolve to
`/app/etc/passwd.map`. Path normalisation now happens before the containment
check, and server frames — which this process produced itself — are the only
ones allowed to name absolute paths.

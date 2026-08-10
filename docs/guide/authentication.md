# Authentication

The dashboard shows stack traces, source excerpts and request headers from
your production application. It has to be protected, and the module refuses to
guess on your behalf: with no credentials configured, every dashboard route
answers `404`.

In development that rule is relaxed: the dashboard is served without a
password so you can read your own errors without configuring anything. See
[In development](#in-development) for why that cannot follow you to production.

## Setting a password

The convenient form, fine in development:

```ts
monitor: {
  auth: {
    username: 'admin',
    password: process.env.MONITOR_PASSWORD,
  },
}
```

The better form for production, where the plaintext never appears in your
config or your build output:

```bash
npx monitor hash-password
# Password: ••••••••
# scrypt$16384$8$1$B9LU0+9UzkVAs/…$J8oKz1KAr0H1tHRFsAEz…
```

```ts
monitor: {
  auth: { passwordHash: process.env.MONITOR_PASSWORD_HASH },
}
```

`passwordHash` wins over `password` when both are present. Reading from a
prompt rather than `argv` keeps the password out of your shell history and out
of the process list.

The hash goes to stdout and nothing else, so it can be piped — or passed
directly where no prompt is available, accepting that it is then visible to
anything that can read the process list:

```bash
npx monitor hash-password > .hash
npx monitor hash-password "$PASSWORD"
```

The format carries its own parameters, so a hash made today stays verifiable if
the defaults change:

```
scrypt$16384$8$1$<salt base64>$<derived key base64>
```

## Setting it at runtime instead

`NUXT_MONITOR_AUTH_PASSWORD` is read when the server starts rather than when it
is built. That is what you want when one build is deployed to several
environments, or when the password is a secret your platform injects.

```bash
NUXT_MONITOR_AUTH_PASSWORD=… node .output/server/index.mjs
```

The build warns once if it finds no password, since forgetting entirely is the
common mistake. It does not bake the decision in: an install that supplies the
password at start-up is perfectly ordinary, and refusing it at build time would
lock those deployments out with no way to recover.

## In development

`nuxt dev` serves the dashboard without a password. Requiring a credential to
read your own errors on localhost is friction with nothing behind it, so
[`auth.optional`](../config/#auth-optional) defaults to on there.

To rehearse the real login locally — checking a reverse proxy, or the cookie
flags — turn it off:

```ts
monitor: {
  auth: {
    optional: false,
    password: process.env.MONITOR_PASSWORD,
  },
}
```

::: warning It cannot leak into production
`auth.optional` is resolved **at build time** and discarded unless the build is
a dev one, so `optional: true` left in a config file has no effect on a deployed
server. Reading `import.meta.dev` per request instead would leave an open
dashboard one stray `NODE_ENV` away.
:::

## How the session works

Signing in sets a cookie that is:

- **`httpOnly`**, so no script on the page can read it;
- **`Secure`** outside development, so it is never sent over plain HTTP;
- **`SameSite=Lax`**, so it does not ride along on cross-site requests;
- **scoped to the dashboard route**, so it is never attached to your own
  application's requests;
- **signed**, with an expiry inside the payload — a forged or edited cookie
  fails verification rather than being trusted.

`sessionTtl` controls how long it lasts (7 days by default).

### Changing the password logs everyone out

The signing secret is derived from the password when you do not set one
explicitly, so changing the password invalidates every outstanding session —
which is the behaviour you want from a password change.

Set `auth.secret` yourself if you need sessions to survive a password change,
or if you run more than one instance and want a session to work across them.

## Cross-origin requests

Requests that change something — resolving an issue, signing out — must come
from the dashboard's own origin. `SameSite=Lax` blocks the ordinary cross-site
post but not a sibling subdomain: with wildcard DNS,
`evil.internal.example.com` is same-site with `monitor.internal.example.com`
and the browser attaches the cookie.

Signing in is deliberately exempt. It acts on nobody's behalf, and requiring
an `Origin` header would break every non-browser client.

# admin

Serves the small HTTP API the Header Setter extension talks to.

- `GET /routes` returns the current mappings.
- `POST /routes` replaces all of them, so the extension never has to reason about
  routes it removed while the proxy was not running.
- `GET /health` reports the route count and the last failure per requested host,
  which the popup shows next to the route. `POST /routes` clears those failures
  with the table.

The API has no credentials; it answers with CORS headers so the extension can
reach it from its popup and service worker, but only serves a browser `Origin`
that is `chrome-extension://`. It must therefore only ever be bound to a
loopback address, which the configuration enforces.

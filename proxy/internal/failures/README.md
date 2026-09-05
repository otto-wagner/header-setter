# failures

Remembers the last reason a routed host could not be reached, keyed by the
requested host.

The reason only exists in the proxy log otherwise: a `CONNECT` the proxy
answers with `502` just becomes `ERR_TUNNEL_CONNECTION_FAILED` in the browser,
saying nothing about a name that does not resolve or a VPN that is not
connected.

- The tunnel records a failure for a **routed** host only, and clears it as
  soon as a connection to that host succeeds.
- The admin API resets the whole log when the route table is replaced, since
  an edited route may point somewhere else entirely.
- `GET /health` returns what is left, which is what the popup shows next to
  the route.

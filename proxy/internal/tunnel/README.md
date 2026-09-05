# tunnel

Serves the proxy that the browser is pointed at through a PAC script.

Only `https://` is served, as a `CONNECT host:port` request; any other method
is rejected. `CONNECT` gets a byte relay: the tunnel connects to the resolved
target, answers `200 Connection Established`, then copies bytes in both
directions unmodified. Chrome still derives the `Host` header and TLS SNI from
the original URL, since it forbids extensions from changing either directly.

Because TLS is never terminated, a route only works when the target's
certificate is also valid for the requested host.

A failed connection to a **routed** host is handed to the configured
`FailureRecorder` (see `internal/failures`), which the admin API and popup
surface, since the browser only ever shows that a tunnel failed. A DNS failure
is called out specifically, since a VPN-only internal hostname is the most
common cause.

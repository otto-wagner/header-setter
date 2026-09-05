# routes

Holds the host mappings of the running proxy: which host a browser asks for, and
which host the connection should actually go to.

The table is the single piece of shared state in the process. The tunnel reads it
for every incoming connection, the admin API replaces it whenever the extension
pushes an update, so every access is guarded by a read/write mutex.

`Resolve` never fails: a host without a mapping resolves to itself, which is what
keeps an accidentally proxied host working normally.

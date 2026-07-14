# Build Assistant workflow

A trusted symbolic command starts once. The assistant records initial status, diagnoses with bounded log deltas, repairs, rebuilds or reobserves, and reviews for at most three passes. Watcher readiness and result patterns come from trusted configuration. The process remains alive during bounded model reconnects and is terminated on every exit path.

Dry-run edits only the overlay, cannot verify the unchanged workspace, and ends with `repair proposed, verification not executed` plus a nonzero workflow result when repair was needed.

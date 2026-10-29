# Media reconciliation

Run `node --conditions=react-server --import tsx scripts/reconcile-media.ts` periodically as a restricted maintenance identity with the configured database and object-storage access. Scheduling is not configured by the application. Alert on a non-zero exit and retry on the next run.

Each invocation claims at most 100 due assets and defers their next attempt by one minute. Concurrent workers skip locked claims; failed or interrupted claims become due again. Retired and deleted tombstones retain their immutable object keys and remain eligible indefinitely. A successful deletion does not establish permanent absence: a delayed write can arrive after it. Eventual deletion depends on upload activity eventually stopping, object storage becoming available, and the worker continuing to run. Pending uploads expire after 24 hours; individual attempts use database-backed 60-second leases. Storage operations use bounded client request timeouts, but a remote server may complete a request after a timeout. Referenced ready assets are not eligible.

Each claimed batch has a unique database claim ID. The worker checks that identity and its unexpired deadline before retirement and before the completion update. A stale request may still issue a storage DELETE, but cannot complete over a newer claim; retired keys remain eligible for later idempotent sweeps. A batch that runs beyond the deadline can report failures and must be retried.

The worker logs aggregate failures only. It requires the media migration and storage configuration. Deploy neither the worker nor the migration without the appropriate environment review.

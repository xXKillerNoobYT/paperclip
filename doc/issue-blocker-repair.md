# Issue blocker relation audit and repair

`pnpm issue-blockers:audit` scans only direct `blocks` relations for the prohibited stored edges: self, ancestor, descendant, `done`, and `cancelled` blockers. It never adds edges, changes issue hierarchy, statuses, review requirements, device gates, or approval gates.

## Commands

Default is read-only dry-run. Scope to a company in normal operation and save an inspectable JSON artifact:

```sh
pnpm issue-blockers:audit -- --company <company-id> --output blocker-audit-dry-run.json
```

Apply removes only edge IDs reported by the same scan and performs a readback query. The command exits nonzero if readback still finds an invalid edge:

```sh
pnpm issue-blockers:audit -- --company <company-id> --apply --output blocker-audit-apply.json
```

The artifact contains `invalidEdges`, `deletedEdgeIds`, and, for apply, `readbackInvalidEdges`. An empty `readbackInvalidEdges` is the required zero-invalid-edge proof. The command is idempotent: rerunning after a clean apply reports no invalid edges and deletes nothing.

## Rollback

The repair is deliberately destructive only for invalid direct edges. Before apply, retain the dry-run artifact; it is the audit record containing each removed edge's company, blocker, blocked issue, reason, and creation timestamp. If a removed dependency must be restored, first confirm the relationship is now valid under the current hierarchy and status rules, then restore that exact direct edge through the normal authenticated issue mutation API. Do not restore ancestor, descendant, self, done, or cancelled blockers, and do not reconstruct an edge from status text alone.

import { writeFile } from "node:fs/promises";
import { and, eq, inArray } from "../packages/db/node_modules/drizzle-orm/index.js";
import { companies, createDb, issueRelations, issues } from "../packages/db/src/index.js";
import { resolveMigrationConnection } from "../packages/db/src/migration-runtime.js";

type InvalidReason = "self" | "ancestor" | "descendant" | "done" | "cancelled";
type AuditEdge = {
  id: string;
  companyId: string;
  blockerIssueId: string;
  blockedIssueId: string;
  reason: InvalidReason;
  createdAt: string;
};

function flag(name: string) {
  return process.argv.includes(name);
}

function value(name: string) {
  const index = process.argv.indexOf(name);
  const candidate = index >= 0 ? process.argv[index + 1] : null;
  return candidate && !candidate.startsWith("--") ? candidate : null;
}

function invalidEdges(
  issueRows: Array<{ id: string; parentId: string | null; status: string }>,
  relationRows: Array<{ id: string; companyId: string; issueId: string; relatedIssueId: string; createdAt: Date }>,
): AuditEdge[] {
  const issueById = new Map(issueRows.map((issue) => [issue.id, issue]));
  return relationRows.flatMap((relation) => {
    const blocker = issueById.get(relation.issueId);
    const blocked = issueById.get(relation.relatedIssueId);
    if (!blocker || !blocked) return [];
    let reason: InvalidReason | null = null;
    if (blocker.id === blocked.id) reason = "self";
    // `createChild({ blockParentUntilDone: true })` intentionally creates this
    // child-to-parent gate. It is not a user-supplied hierarchy blocker and must
    // survive repair so review/device/approval gates remain intact.
    else if (blocker.parentId === blocked.id) return [];
    else if (blocker.status === "done" || blocker.status === "cancelled") reason = blocker.status;
    else {
      const ancestors = new Set<string>();
      for (let currentId: string | null = blocked.parentId; currentId; currentId = issueById.get(currentId)?.parentId ?? null) {
        if (ancestors.has(currentId)) break;
        ancestors.add(currentId);
        if (currentId === blocker.id) reason = "ancestor";
      }
      const descendants = new Set<string>();
      for (let currentId: string | null = blocker.parentId; currentId; currentId = issueById.get(currentId)?.parentId ?? null) {
        if (descendants.has(currentId)) break;
        descendants.add(currentId);
        if (currentId === blocked.id) reason = "descendant";
      }
    }
    return reason ? [{
      id: relation.id,
      companyId: relation.companyId,
      blockerIssueId: relation.issueId,
      blockedIssueId: relation.relatedIssueId,
      reason,
      createdAt: relation.createdAt.toISOString(),
    }] : [];
  });
}

async function main() {
  const apply = flag("--apply");
  const companyId = value("--company");
  const output = value("--output");
  const connection = await resolveMigrationConnection();
  const db = createDb(connection.connectionString);
  try {
    const companyIds = companyId
      ? [companyId]
      : (await db.select({ id: companies.id }).from(companies)).map((company) => company.id);
    const audit: { mode: "dry-run" | "apply"; invalidEdges: AuditEdge[]; deletedEdgeIds: string[]; readbackInvalidEdges: AuditEdge[] } = {
      mode: apply ? "apply" : "dry-run",
      invalidEdges: [],
      deletedEdgeIds: [],
      readbackInvalidEdges: [],
    };

    for (const currentCompanyId of companyIds) {
      const [issueRows, relationRows] = await Promise.all([
        db.select({ id: issues.id, parentId: issues.parentId, status: issues.status })
          .from(issues).where(eq(issues.companyId, currentCompanyId)),
        db.select({ id: issueRelations.id, companyId: issueRelations.companyId, issueId: issueRelations.issueId, relatedIssueId: issueRelations.relatedIssueId, createdAt: issueRelations.createdAt })
          .from(issueRelations).where(and(eq(issueRelations.companyId, currentCompanyId), eq(issueRelations.type, "blocks"))),
      ]);
      const invalid = invalidEdges(issueRows, relationRows);
      audit.invalidEdges.push(...invalid);
      if (apply && invalid.length > 0) {
        await db.delete(issueRelations).where(and(eq(issueRelations.companyId, currentCompanyId), inArray(issueRelations.id, invalid.map((edge) => edge.id))));
        audit.deletedEdgeIds.push(...invalid.map((edge) => edge.id));
      }
    }

    if (apply) {
      for (const currentCompanyId of companyIds) {
        const [issueRows, relationRows] = await Promise.all([
          db.select({ id: issues.id, parentId: issues.parentId, status: issues.status })
            .from(issues).where(eq(issues.companyId, currentCompanyId)),
          db.select({ id: issueRelations.id, companyId: issueRelations.companyId, issueId: issueRelations.issueId, relatedIssueId: issueRelations.relatedIssueId, createdAt: issueRelations.createdAt })
            .from(issueRelations).where(and(eq(issueRelations.companyId, currentCompanyId), eq(issueRelations.type, "blocks"))),
        ]);
        audit.readbackInvalidEdges.push(...invalidEdges(issueRows, relationRows));
      }
    }

    const serialized = `${JSON.stringify(audit, null, 2)}\n`;
    if (output) await writeFile(output, serialized, "utf8");
    process.stdout.write(serialized);
    if (apply && audit.readbackInvalidEdges.length > 0) process.exitCode = 2;
  } finally {
    await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
    await connection.stop();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  if (error instanceof Error && error.cause instanceof Error) {
    console.error(`Cause: ${error.cause.message}`);
  }
  process.exitCode = 1;
});

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { createDb, executionWorkspaces, projects, projectWorkspaces } from "../src/index.js";
import { loadConfig } from "../../../server/src/config.js";

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function usage() {
  console.log([
    "Usage: pnpm --filter @paperclipai/db exec tsx scripts/remediate-record-only-workspace-archives.ts --company-id <uuid> [--expected-count N] [--apply]",
    "",
    "Dry-run is the default. This only updates execution workspace records matching all of:",
    "- status cleanup_failed with null cleanupReason and non-null closedAt",
    "- shared_workspace/project_primary/local_fs",
    "- runtime did not create the directory",
    "- no workspace, project workspace, or project teardown cleanup command is configured",
    "",
    "No filesystem, git worktree, or branch deletion is performed.",
  ].join("\n"));
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    usage();
    return;
  }

  const companyId = flagValue("--company-id");
  if (!companyId) {
    usage();
    throw new Error("--company-id is required");
  }

  const expectedCountRaw = flagValue("--expected-count");
  const expectedCount = expectedCountRaw ? Number.parseInt(expectedCountRaw, 10) : null;
  if (expectedCountRaw && (!Number.isInteger(expectedCount) || expectedCount < 0)) {
    throw new Error("--expected-count must be a non-negative integer");
  }

  const apply = hasFlag("--apply");
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  const candidates = await db
    .select({
      id: executionWorkspaces.id,
      name: executionWorkspaces.name,
      cwd: executionWorkspaces.cwd,
      closedAt: executionWorkspaces.closedAt,
    })
    .from(executionWorkspaces)
    .leftJoin(
      projectWorkspaces,
      and(
        eq(projectWorkspaces.id, executionWorkspaces.projectWorkspaceId),
        eq(projectWorkspaces.companyId, executionWorkspaces.companyId),
      ),
    )
    .leftJoin(
      projects,
      and(
        eq(projects.id, executionWorkspaces.projectId),
        eq(projects.companyId, executionWorkspaces.companyId),
      ),
    )
    .where(and(
      eq(executionWorkspaces.companyId, companyId),
      eq(executionWorkspaces.status, "cleanup_failed"),
      isNull(executionWorkspaces.cleanupReason),
      isNotNull(executionWorkspaces.closedAt),
      eq(executionWorkspaces.mode, "shared_workspace"),
      eq(executionWorkspaces.strategyType, "project_primary"),
      eq(executionWorkspaces.providerType, "local_fs"),
      isNull(projectWorkspaces.cleanupCommand),
      sql`${executionWorkspaces.metadata}->>'createdByRuntime' IS DISTINCT FROM 'true'`,
      sql`${executionWorkspaces.metadata}->'config'->>'cleanupCommand' IS NULL`,
      sql`${executionWorkspaces.metadata}->'config'->>'teardownCommand' IS NULL`,
      sql`${projects.executionWorkspacePolicy}->'workspaceStrategy'->>'teardownCommand' IS NULL`,
    ))
    .orderBy(executionWorkspaces.closedAt, executionWorkspaces.id);

  console.log(`${apply ? "Applying" : "Dry-run"} record-only workspace archive remediation.`);
  console.log(`Matched ${candidates.length} candidate record${candidates.length === 1 ? "" : "s"}.`);
  for (const candidate of candidates) {
    console.log(`- ${candidate.id} ${candidate.name} closedAt=${candidate.closedAt?.toISOString() ?? "null"} cwd=${candidate.cwd ?? "null"}`);
  }

  if (expectedCount !== null && candidates.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} candidates but matched ${candidates.length}; no records updated.`);
  }

  if (!apply) {
    console.log("Dry-run complete; rerun with --apply to update status to archived.");
    return;
  }

  if (candidates.length === 0) {
    console.log("No records to update.");
    return;
  }

  const updated = await db
    .update(executionWorkspaces)
    .set({
      status: "archived",
      cleanupReason: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(executionWorkspaces.companyId, companyId),
      inArray(executionWorkspaces.id, candidates.map((candidate) => candidate.id)),
      eq(executionWorkspaces.status, "cleanup_failed"),
      isNull(executionWorkspaces.cleanupReason),
    ))
    .returning({ id: executionWorkspaces.id });

  console.log(`Updated ${updated.length} record${updated.length === 1 ? "" : "s"} to archived.`);
  if (expectedCount !== null && updated.length !== expectedCount) {
    throw new Error(`Expected to update ${expectedCount} records but updated ${updated.length}.`);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

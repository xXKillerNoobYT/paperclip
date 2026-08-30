import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import {
  createBufferedTextFileWriter,
  DatabaseBackupError,
  pruneOldBackups,
  publishVerifiedGzip,
  runDatabaseBackup,
  runDatabaseRestore,
  verifyGzipFile,
} from "./backup-lib.js";
import { ensurePostgresDatabase } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void> | void> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-backup-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function createSiblingDatabase(connectionString: string, databaseName: string): Promise<string> {
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  await ensurePostgresDatabase(adminUrl.toString(), databaseName);
  const targetUrl = new URL(connectionString);
  targetUrl.pathname = `/${databaseName}`;
  return targetUrl.toString();
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
}, 60_000);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres backup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("createBufferedTextFileWriter", () => {
  it("preserves line boundaries across buffered flushes", async () => {
    const tempDir = createTempDir("paperclip-buffered-writer-");
    const outputPath = path.join(tempDir, "backup.sql");
    const writer = createBufferedTextFileWriter(outputPath, 16);
    const lines = [
      "-- header",
      "BEGIN;",
      "",
      "INSERT INTO test VALUES (1);",
      "-- footer",
    ];

    for (const line of lines) {
      writer.emit(line);
    }

    await writer.close();

    expect(fs.readFileSync(outputPath, "utf8")).toBe(lines.join("\n"));
  });
});

describe("atomic backup publication", () => {
  it("retains a truncated gzip intermediate without publishing a final archive", async () => {
    const tempDir = createTempDir("paperclip-truncated-backup-");
    const intermediateFile = path.join(tempDir, "paperclip-20260715-010203.sql.gz.partial-test-run");
    const backupFile = path.join(tempDir, "paperclip-20260715-010203.sql.gz");
    const complete = gzipSync("SELECT 1;\n");
    fs.writeFileSync(intermediateFile, complete.subarray(0, complete.length - 4));

    await expect(publishVerifiedGzip(intermediateFile, backupFile)).rejects.toMatchObject({
      retainedArtifacts: [intermediateFile],
    });

    expect(fs.existsSync(backupFile)).toBe(false);
    expect(fs.existsSync(intermediateFile)).toBe(true);
    await expect(verifyGzipFile(intermediateFile)).rejects.toThrow();
  });

  it("atomically publishes a valid gzip and removes only that intermediate", async () => {
    const tempDir = createTempDir("paperclip-valid-backup-");
    const intermediateFile = path.join(tempDir, "paperclip-20260715-010203.sql.gz.partial-test-run");
    const unrelatedIntermediate = path.join(tempDir, "paperclip-20260715-010204.sql.gz.partial-other-run");
    const backupFile = path.join(tempDir, "paperclip-20260715-010203.sql.gz");
    fs.writeFileSync(intermediateFile, gzipSync("SELECT 1;\n"));
    fs.writeFileSync(unrelatedIntermediate, "other run");

    await publishVerifiedGzip(intermediateFile, backupFile);

    await expect(verifyGzipFile(backupFile)).resolves.toBeUndefined();
    expect(fs.existsSync(intermediateFile)).toBe(false);
    expect(fs.existsSync(unrelatedIntermediate)).toBe(true);
  });

  it("never replaces an existing final archive during concurrent publication", async () => {
    const tempDir = createTempDir("paperclip-concurrent-backup-");
    const intermediateFile = path.join(tempDir, "paperclip-20260715-010203.sql.gz.partial-second-run");
    const backupFile = path.join(tempDir, "paperclip-20260715-010203.sql.gz");
    const firstArchive = gzipSync("SELECT 'first';\n");
    fs.writeFileSync(backupFile, firstArchive);
    fs.writeFileSync(intermediateFile, gzipSync("SELECT 'second';\n"));

    await expect(publishVerifiedGzip(intermediateFile, backupFile)).rejects.toMatchObject({
      retainedArtifacts: [intermediateFile],
    });

    expect(fs.readFileSync(backupFile)).toEqual(firstArchive);
    expect(fs.existsSync(intermediateFile)).toBe(true);
  });

  it("never overwrites a destination created between validation and publication", async () => {
    const tempDir = createTempDir("paperclip-publication-race-");
    const intermediateFile = path.join(tempDir, "paperclip-20260715-010203.sql.gz.partial-run");
    const backupFile = path.join(tempDir, "paperclip-20260715-010203.sql.gz");
    const competingArchive = gzipSync("SELECT 'competing writer';\n");
    fs.writeFileSync(intermediateFile, gzipSync("SELECT 'this run';\n"));

    const realLinkSync = fs.linkSync;
    const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation((existingPath, newPath) => {
      if (existingPath === intermediateFile && newPath === backupFile) {
        fs.writeFileSync(backupFile, competingArchive);
      }
      return realLinkSync(existingPath, newPath);
    });
    syncBuiltinESMExports();

    try {
      await expect(publishVerifiedGzip(intermediateFile, backupFile)).rejects.toMatchObject({
        retainedArtifacts: [intermediateFile],
      });
    } finally {
      linkSpy.mockRestore();
      syncBuiltinESMExports();
    }

    expect(fs.readFileSync(backupFile)).toEqual(competingArchive);
    expect(fs.existsSync(intermediateFile)).toBe(true);
  });

  it("reports post-publication cleanup separately without failing the durable backup", async () => {
    const tempDir = createTempDir("paperclip-publication-cleanup-");
    const intermediateFile = path.join(tempDir, "paperclip-20260715-010203.sql.gz.partial-run");
    const backupFile = path.join(tempDir, "paperclip-20260715-010203.sql.gz");
    const archive = gzipSync("SELECT 'durable';\n");
    fs.writeFileSync(intermediateFile, archive);

    const realUnlinkSync = fs.unlinkSync;
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((filePath) => {
      if (filePath === intermediateFile) {
        throw new Error("simulated cleanup failure");
      }
      return realUnlinkSync(filePath);
    });
    syncBuiltinESMExports();

    try {
      await expect(publishVerifiedGzip(intermediateFile, backupFile)).resolves.toEqual([intermediateFile]);
    } finally {
      unlinkSpy.mockRestore();
      syncBuiltinESMExports();
    }

    await expect(verifyGzipFile(backupFile)).resolves.toBeUndefined();
    expect(fs.readFileSync(backupFile)).toEqual(archive);
    expect(fs.existsSync(intermediateFile)).toBe(true);
  });
});

describe("integrity-aware backup retention", () => {
  it("counts only valid automatic archives, keeps 24, and preserves manual and invalid files", async () => {
    const tempDir = createTempDir("paperclip-backup-retention-");
    const now = new Date("2026-07-15T12:00:00.000Z");
    const automaticFiles: string[] = [];

    for (let index = 0; index < 30; index += 1) {
      const stamp = String(index).padStart(2, "0");
      const filePath = path.join(tempDir, `paperclip-20260501-00${stamp}00.sql.gz`);
      fs.writeFileSync(filePath, gzipSync(`SELECT ${index};\n`));
      const mtime = new Date(now.getTime() - (60 + index) * 86_400_000);
      fs.utimesSync(filePath, mtime, mtime);
      automaticFiles.push(filePath);
    }

    const manualFile = path.join(tempDir, "paperclip-manual-20260501-010101.sql.gz");
    const legacyManualFile = path.join(tempDir, "manual.sql");
    const invalidAutomaticFile = path.join(tempDir, "paperclip-20260401-010101.sql.gz");
    fs.writeFileSync(manualFile, gzipSync("SELECT 'manual';\n"));
    fs.writeFileSync(legacyManualFile, "SELECT 'legacy';\n");
    fs.writeFileSync(invalidAutomaticFile, gzipSync("SELECT 'invalid';\n").subarray(0, 8));

    const result = await pruneOldBackups(
      tempDir,
      { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
      "paperclip",
      now,
    );

    expect(result.prunedCount).toBe(6);
    expect(result.invalidBackupFiles).toEqual([invalidAutomaticFile]);
    expect(automaticFiles.filter((filePath) => fs.existsSync(filePath))).toHaveLength(24);
    expect(fs.existsSync(manualFile)).toBe(true);
    expect(fs.existsSync(legacyManualFile)).toBe(true);
    expect(fs.existsSync(invalidAutomaticFile)).toBe(true);
  });

  it("never deletes the only valid automatic backup", async () => {
    const tempDir = createTempDir("paperclip-backup-retention-floor-");
    const onlyBackup = path.join(tempDir, "paperclip-20260101-010101.sql.gz");
    fs.writeFileSync(onlyBackup, gzipSync("SELECT 1;\n"));
    fs.utimesSync(onlyBackup, new Date("2026-01-01T01:01:01.000Z"), new Date("2026-01-01T01:01:01.000Z"));

    const result = await pruneOldBackups(
      tempDir,
      { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
      "paperclip",
      new Date("2026-07-15T12:00:00.000Z"),
    );

    expect(result.prunedCount).toBe(0);
    expect(fs.existsSync(onlyBackup)).toBe(true);
  });

  it("revalidates cached archives before pruning below the 24-valid floor", async () => {
    const tempDir = createTempDir("paperclip-backup-stale-cache-");
    const now = new Date("2026-07-15T12:00:00.000Z");

    for (let index = 0; index < 25; index += 1) {
      const stamp = String(index).padStart(2, "0");
      const filePath = path.join(tempDir, `paperclip-20260501-00${stamp}00.sql.gz`);
      fs.writeFileSync(filePath, gzipSync(`SELECT ${index};\n`));
      const mtime = new Date(now.getTime() - (60 + index) * 86_400_000);
      fs.utimesSync(filePath, mtime, mtime);
    }

    const retention = { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 };
    const firstResult = await pruneOldBackups(tempDir, retention, "paperclip", now);
    expect(firstResult.prunedCount).toBe(1);

    const retainedArchives = fs.readdirSync(tempDir)
      .filter((name) => /^paperclip-\d{8}-\d{6}\.sql\.gz$/.test(name))
      .map((name) => path.join(tempDir, name));
    expect(retainedArchives).toHaveLength(24);

    const corruptedArchive = retainedArchives[0]!;
    const originalStat = fs.statSync(corruptedArchive);
    fs.writeFileSync(corruptedArchive, Buffer.alloc(originalStat.size));
    fs.utimesSync(corruptedArchive, originalStat.atime, originalStat.mtime);

    const replacementArchive = path.join(tempDir, "paperclip-20260502-010101.sql.gz");
    fs.writeFileSync(replacementArchive, gzipSync("SELECT 'replacement';\n"));
    const replacementMtime = new Date(now.getTime() - 59 * 86_400_000);
    fs.utimesSync(replacementArchive, replacementMtime, replacementMtime);

    const secondResult = await pruneOldBackups(tempDir, retention, "paperclip", now);
    expect(secondResult.prunedCount).toBe(0);
    expect(secondResult.invalidBackupFiles).toEqual([corruptedArchive]);

    const validArchives = fs.readdirSync(tempDir)
      .filter((name) => /^paperclip-\d{8}-\d{6}\.sql\.gz$/.test(name))
      .map((name) => path.join(tempDir, name));
    const validity = await Promise.all(validArchives.map(async (filePath) => {
      try {
        await verifyGzipFile(filePath);
        return true;
      } catch {
        return false;
      }
    }));
    expect(validity.filter(Boolean)).toHaveLength(24);
  });
});

describeEmbeddedPostgres("runDatabaseBackup", () => {
  it(
    "reports retained run artifacts and publishes no final when full-run publication fails",
    async () => {
      const connectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-publication-failure-");
      const realLinkSync = fs.linkSync;
      const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation((existingPath, newPath) => {
        if (
          typeof existingPath === "string"
          && typeof newPath === "string"
          && existingPath.startsWith(backupDir)
          && existingPath.includes(".sql.gz.partial-")
          && newPath.startsWith(backupDir)
          && newPath.endsWith(".sql.gz")
        ) {
          throw Object.assign(new Error("simulated full-run publication failure"), { code: "EIO" });
        }
        return realLinkSync(existingPath, newPath);
      });
      syncBuiltinESMExports();

      let backupError: unknown;
      try {
        await runDatabaseBackup({
          connectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-failure-lifecycle",
          backupEngine: "javascript",
        });
      } catch (error) {
        backupError = error;
      } finally {
        linkSpy.mockRestore();
        syncBuiltinESMExports();
      }

      expect(backupError).toBeInstanceOf(DatabaseBackupError);
      const retainedArtifacts = (backupError as DatabaseBackupError).retainedArtifacts;
      expect(retainedArtifacts).toHaveLength(2);
      expect(retainedArtifacts.every((filePath) => fs.existsSync(filePath))).toBe(true);
      expect(retainedArtifacts.some((filePath) => filePath.includes(".sql.gz.partial-"))).toBe(true);
      expect(retainedArtifacts.some((filePath) => filePath.endsWith(".sql"))).toBe(true);
      expect(
        fs.readdirSync(backupDir).filter((name) => name.endsWith(".sql.gz")),
      ).toEqual([]);
    },
    60_000,
  );

  it(
    "returns a valid final and diagnoses retained cleanup artifacts after full-run publication",
    async () => {
      const connectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-cleanup-failure-");
      const unrelatedArtifact = path.join(backupDir, "paperclip-other.sql.gz.partial-other-run");
      const unrelatedContents = "unrelated run artifact";
      fs.writeFileSync(unrelatedArtifact, unrelatedContents);
      const diagnostics: Array<{
        code: string;
        backupFile: string;
        retainedArtifacts?: string[];
      }> = [];
      const realUnlinkSync = fs.unlinkSync;
      const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((filePath) => {
        if (
          typeof filePath === "string"
          && filePath.startsWith(backupDir)
          && filePath.includes("paperclip-cleanup-lifecycle-")
          && filePath.includes(".sql.gz.partial-")
          && !filePath.endsWith(".sql")
        ) {
          throw new Error("simulated full-run cleanup failure");
        }
        return realUnlinkSync(filePath);
      });
      syncBuiltinESMExports();

      let result;
      try {
        result = await runDatabaseBackup({
          connectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-cleanup-lifecycle",
          backupEngine: "javascript",
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        });
      } finally {
        unlinkSpy.mockRestore();
        syncBuiltinESMExports();
      }

      expect(result).toBeDefined();
      await expect(verifyGzipFile(result!.backupFile)).resolves.toBeUndefined();
      expect(fs.readFileSync(unrelatedArtifact, "utf8")).toBe(unrelatedContents);
      const cleanupDiagnostic = diagnostics.find((diagnostic) => diagnostic.code === "cleanup_failed");
      expect(cleanupDiagnostic).toMatchObject({
        code: "cleanup_failed",
        backupFile: result!.backupFile,
      });
      expect(cleanupDiagnostic?.retainedArtifacts).toHaveLength(1);
      const retainedPath = cleanupDiagnostic?.retainedArtifacts?.[0];
      expect(retainedPath).toContain("paperclip-cleanup-lifecycle-");
      expect(retainedPath).toContain(".sql.gz.partial-");
      expect(retainedPath && fs.existsSync(retainedPath)).toBe(true);
      expect(retainedPath).not.toBe(unrelatedArtifact);
    },
    60_000,
  );

  it(
    "restores large COPY payloads through the no-psql incremental stream",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-backup-output-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const originalPsqlPath = process.env.PAPERCLIP_PSQL_PATH;

      try {
        await sourceSql.unsafe(`
          CREATE TYPE "public"."backup_test_state" AS ENUM ('pending', 'done');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_test_records" (
            "id" serial PRIMARY KEY,
            "title" text NOT NULL,
            "payload" text NOT NULL,
            "state" "public"."backup_test_state" NOT NULL,
            "metadata" jsonb,
            "created_at" timestamptz NOT NULL DEFAULT now()
          );
        `);

        const payload = "x".repeat(8192);
        for (let index = 0; index < 160; index += 1) {
          const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
          await sourceSql`
            INSERT INTO "public"."backup_test_records" (
              "title",
              "payload",
              "state",
              "metadata",
              "created_at"
            )
            VALUES (
              ${`row-${index}`},
              ${payload},
              ${index % 2 === 0 ? "pending" : "done"}::"public"."backup_test_state",
              ${JSON.stringify({ index, even: index % 2 === 0 })}::jsonb,
              ${createdAt}
            )
          `;
        }

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-test",
          backupEngine: "javascript",
        });

        expect(result.backupFile).toMatch(/paperclip-test-.*\.sql\.gz$/);
        expect(result.sizeBytes).toBeGreaterThan(0);
        expect(fs.existsSync(result.backupFile)).toBe(true);

        process.env.PAPERCLIP_PSQL_PATH = "/bin/false";
        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const counts = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."backup_test_records"
        `);
        expect(counts[0]?.count).toBe(160);

        const sampleRows = await restoreSql.unsafe<{
          title: string;
          payload: string;
          state: string;
          metadata: { index: number; even: boolean } | string;
        }[]>(`
          SELECT "title", "payload", "state"::text AS "state", "metadata"
          FROM "public"."backup_test_records"
          WHERE "title" IN ('row-0', 'row-159')
          ORDER BY "title"
        `);
        expect(sampleRows.map((row) => ({
          ...row,
          metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
        }))).toEqual([
          {
            title: "row-0",
            payload,
            state: "pending",
            metadata: { index: 0, even: true },
          },
          {
            title: "row-159",
            payload,
            state: "done",
            metadata: { index: 159, even: false },
          },
        ]);
      } finally {
        if (originalPsqlPath === undefined) {
          delete process.env.PAPERCLIP_PSQL_PATH;
        } else {
          process.env.PAPERCLIP_PSQL_PATH = originalPsqlPath;
        }
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "backs up and restores non-public database schemas and migration history",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_full_logical_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-full-logical-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE SCHEMA IF NOT EXISTS "drizzle";
          CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
            "id" serial PRIMARY KEY,
            "hash" text NOT NULL,
            "created_at" bigint
          );
          INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
          VALUES ('paperclip-migration-history', 1770000000000);
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_parent_records" (
            "id" uuid PRIMARY KEY,
            "name" text NOT NULL
          );
          INSERT INTO "public"."backup_parent_records" ("id", "name")
          VALUES ('11111111-1111-4111-8111-111111111111', 'parent');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."plugin_rows" (
            "id" serial PRIMARY KEY,
            "note" text NOT NULL
          );
          CREATE TABLE "public"."audit_rows" (
            "id" serial PRIMARY KEY,
            "secret_note" text
          );
          INSERT INTO "public"."plugin_rows" ("note")
          VALUES ('public-collision');
          INSERT INTO "public"."audit_rows" ("secret_note")
          VALUES ('public-secret');
        `);
        await sourceSql.unsafe(`
          CREATE SCHEMA "plugin_backup_scope";
          CREATE TYPE "plugin_backup_scope"."plugin_status" AS ENUM ('ready', 'done');
          CREATE TABLE "plugin_backup_scope"."plugin_rows" (
            "id" serial PRIMARY KEY,
            "parent_id" uuid NOT NULL REFERENCES "public"."backup_parent_records"("id") ON DELETE CASCADE,
            "status" "plugin_backup_scope"."plugin_status" NOT NULL,
            "note" text NOT NULL
          );
          CREATE TABLE "plugin_backup_scope"."audit_rows" (
            "id" serial PRIMARY KEY,
            "secret_note" text
          );
          CREATE UNIQUE INDEX "plugin_rows_note_uq" ON "plugin_backup_scope"."plugin_rows" ("note");
          INSERT INTO "plugin_backup_scope"."plugin_rows" ("parent_id", "status", "note")
            VALUES ('11111111-1111-4111-8111-111111111111', 'ready', 'first');
          INSERT INTO "plugin_backup_scope"."audit_rows" ("secret_note")
          VALUES ('plugin-secret');
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-full-logical-test",
          backupEngine: "javascript",
          excludeTables: ["plugin_rows"],
          nullifyColumns: {
            audit_rows: ["secret_note"],
          },
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const migrationRows = await restoreSql.unsafe<{ hash: string }[]>(`
          SELECT "hash"
          FROM "drizzle"."__drizzle_migrations"
          WHERE "hash" = 'paperclip-migration-history'
        `);
        expect(migrationRows).toEqual([{ hash: "paperclip-migration-history" }]);

        const pluginRows = await restoreSql.unsafe<{ note: string; status: string; parent_name: string }[]>(`
          SELECT r."note", r."status"::text AS "status", p."name" AS "parent_name"
          FROM "plugin_backup_scope"."plugin_rows" r
          JOIN "public"."backup_parent_records" p ON p."id" = r."parent_id"
        `);
        expect(pluginRows).toEqual([{ note: "first", status: "ready", parent_name: "parent" }]);

        const publicCollisionRows = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."plugin_rows"
        `);
        expect(publicCollisionRows[0]?.count).toBe(0);

        const publicAuditRows = await restoreSql.unsafe<{ secret_note: string | null }[]>(`
          SELECT "secret_note"
          FROM "public"."audit_rows"
        `);
        expect(publicAuditRows).toEqual([{ secret_note: null }]);

        const pluginAuditRows = await restoreSql.unsafe<{ secret_note: string | null }[]>(`
          SELECT "secret_note"
          FROM "plugin_backup_scope"."audit_rows"
        `);
        expect(pluginAuditRows).toEqual([{ secret_note: "plugin-secret" }]);

        await expect(
          restoreSql.unsafe(`
            INSERT INTO "plugin_backup_scope"."plugin_rows" ("parent_id", "status", "note")
            VALUES ('11111111-1111-4111-8111-111111111111', 'done', 'first')
          `),
        ).rejects.toThrow();
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "preserves composite foreign key column order without duplicate referenced columns",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_composite_fk_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-composite-fk-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE SCHEMA "plugin_composite_fk";
          CREATE TABLE "plugin_composite_fk"."content_cases" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "title" text NOT NULL,
            CONSTRAINT "content_cases_company_case_unique" UNIQUE ("company_id", "id")
          );
          CREATE TABLE "plugin_composite_fk"."content_case_signals" (
            "company_id" uuid NOT NULL,
            "case_id" uuid NOT NULL,
            "signal" text NOT NULL,
            "scopes" text[] NOT NULL,
            "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
            CONSTRAINT "content_case_signals_company_case"
              FOREIGN KEY ("company_id", "case_id")
              REFERENCES "plugin_composite_fk"."content_cases" ("company_id", "id")
              ON DELETE CASCADE
          );
          INSERT INTO "plugin_composite_fk"."content_cases" ("company_id", "id", "title")
          VALUES (
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            'case'
          );
          INSERT INTO "plugin_composite_fk"."content_case_signals" ("company_id", "case_id", "signal", "scopes", "warnings")
          VALUES (
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            'signal',
            ARRAY['upstream_import:preview', 'scope with space', 'quoted "scope"', 'NULL', 'null'],
            jsonb_build_array('json warning', jsonb_build_object('code', 'quoted "value"'))
          );
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-composite-fk-test",
          backupEngine: "javascript",
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const rows = await restoreSql.unsafe<{
          signal: string;
          title: string;
          scopes: string[];
          warnings: Array<string | { code: string }>;
        }[]>(`
          SELECT s."signal", c."title", s."scopes", s."warnings"
          FROM "plugin_composite_fk"."content_case_signals" s
          JOIN "plugin_composite_fk"."content_cases" c
            ON c."company_id" = s."company_id"
           AND c."id" = s."case_id"
        `);
        expect(rows).toEqual([
          {
            signal: "signal",
            title: "case",
            scopes: ["upstream_import:preview", "scope with space", 'quoted "scope"', "NULL", "null"],
            warnings: ["json warning", { code: 'quoted "value"' }],
          },
        ]);

        await expect(
          restoreSql.unsafe(`
            INSERT INTO "plugin_composite_fk"."content_case_signals" ("company_id", "case_id", "signal", "scopes")
            VALUES (
              '11111111-1111-4111-8111-111111111111',
              '33333333-3333-4333-8333-333333333333',
              'orphan',
              ARRAY[]::text[]
            )
          `),
        ).rejects.toThrow();
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "restores fallback COPY data when child tables are dumped before parent tables",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_copy_fk_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-copy-fk-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const originalPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = "/bin/false";

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."zzz_parent_records" (
            "id" uuid PRIMARY KEY,
            "name" text NOT NULL
          );
          CREATE TABLE "public"."aaa_child_records" (
            "id" uuid PRIMARY KEY,
            "parent_id" uuid NOT NULL REFERENCES "public"."zzz_parent_records"("id") ON DELETE CASCADE,
            "note" text NOT NULL
          );
          INSERT INTO "public"."zzz_parent_records" ("id", "name")
          VALUES ('11111111-1111-4111-8111-111111111111', 'parent');
          INSERT INTO "public"."aaa_child_records" ("id", "parent_id", "note")
          VALUES (
            '22222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111',
            'child emitted before parent'
          );
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-copy-fk-test",
          backupEngine: "auto",
        });

        const backupSql = gunzipSync(await fs.promises.readFile(result.backupFile)).toString("utf8");
        expect(backupSql.indexOf("-- Data for: public.aaa_child_records")).toBeGreaterThan(-1);
        expect(backupSql.indexOf("-- Data for: public.aaa_child_records")).toBeLessThan(
          backupSql.indexOf("-- Data for: public.zzz_parent_records"),
        );

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const rows = await restoreSql.unsafe<{ note: string; name: string }[]>(`
          SELECT child."note", parent."name"
          FROM "public"."aaa_child_records" child
          JOIN "public"."zzz_parent_records" parent ON parent."id" = child."parent_id"
        `);
        expect(rows).toEqual([{ note: "child emitted before parent", name: "parent" }]);
      } finally {
        if (originalPgDumpPath === undefined) {
          delete process.env.PAPERCLIP_PG_DUMP_PATH;
        } else {
          process.env.PAPERCLIP_PG_DUMP_PATH = originalPgDumpPath;
        }
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "restores legacy public-only backups without migration history",
    async () => {
      const restoreConnectionString = await createTempDatabase();
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const backupDir = createTempDir("paperclip-db-restore-manual-");
      const backupFile = path.join(backupDir, "manual.sql");

      try {
        await fs.promises.writeFile(
          backupFile,
          [
            "-- Paperclip database backup",
            "-- Created: 2026-04-06T00:00:00.000Z",
            "",
            "BEGIN;",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "CREATE TABLE public.restore_stream_test (id integer primary key, payload text not null);",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "INSERT INTO public.restore_stream_test (id, payload)",
            "VALUES (1, 'hello');",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "COMMIT;",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          ].join("\n"),
          "utf8",
        );

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile,
        });

        const rows = await restoreSql.unsafe<{ payload: string }[]>(`
          SELECT payload
          FROM public.restore_stream_test
        `);
        expect(rows).toEqual([{ payload: "hello" }]);
      } finally {
        await restoreSql.end();
      }
    },
    20_000,
  );
});

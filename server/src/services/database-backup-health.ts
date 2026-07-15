import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { BACKUP_INTEGRITY_FAILURE_MARKER } from "@paperclipai/db";

export type DatabaseBackupHealthWarningCode =
  | "database_backup_check_failed"
  | "database_backup_incomplete"
  | "database_backup_invalid_archive"
  | "database_backup_last_failure"
  | "database_backup_missing"
  | "database_backup_stale";

export type DatabaseBackupHealthWarning = {
  code: DatabaseBackupHealthWarningCode;
  message: string;
};

export type DatabaseBackupHealthStatus = {
  enabled: boolean;
  status: "ok" | "warning";
  backupDir: string;
  maxAgeHours: number;
  latestBackup: {
    name: string;
    path: string;
    mtime: string;
    ageHours: number;
    sizeBytes: number;
  } | null;
  lastFailure: {
    path: string;
    mtime: string;
    message: string;
  } | null;
  retainedIntermediateFiles: string[];
  invalidBackupFiles: string[];
  warnings: DatabaseBackupHealthWarning[];
};

export type InspectDatabaseBackupHealthOptions = {
  enabled: boolean;
  backupDir: string;
  maxAgeHours: number;
  alertFile?: string;
  alertFiles?: string[];
  now?: Date;
};

function roundHours(value: number): number {
  return Math.round(value * 10) / 10;
}

function alertFileCandidates(opts: InspectDatabaseBackupHealthOptions) {
  return [...new Set([
    opts.alertFile,
    ...(opts.alertFiles ?? []),
    join(opts.backupDir, "db-backup-to-s3.failure"),
    resolve(opts.backupDir, "..", "db-backup-to-s3.failure"),
  ].filter((value): value is string => Boolean(value)))];
}

function readLastFailure(alertFiles: string[]) {
  const failures = alertFiles
    .filter((alertFile) => existsSync(alertFile))
    .map((alertFile) => {
      const stat = statSync(alertFile);
      const message = readFileSync(alertFile, "utf8").trim().split(/\r?\n/)[0] ||
        "Database backup failure marker is present.";
      return {
        path: alertFile,
        mtime: new Date(stat.mtimeMs).toISOString(),
        mtimeMs: stat.mtimeMs,
        message,
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const latest = failures[0];
  if (!latest) return null;
  return {
    path: latest.path,
    mtime: latest.mtime,
    message: latest.message,
  };
}

function findLatestBackup(backupDir: string, nowMs: number) {
  if (!existsSync(backupDir)) return null;

  const candidates = readdirSync(backupDir)
    .filter((name) => name.endsWith(".sql.gz"))
    .map((name) => {
      const fullPath = join(backupDir, name);
      const stat = statSync(fullPath);
      return { fullPath, name, stat };
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const latest = candidates[0];
  if (!latest) return null;

  return {
    name: basename(latest.fullPath),
    path: latest.fullPath,
    mtime: new Date(latest.stat.mtimeMs).toISOString(),
    ageHours: roundHours((nowMs - latest.stat.mtimeMs) / 3_600_000),
    sizeBytes: latest.stat.size,
  };
}

function findRetainedIntermediateFiles(backupDir: string): string[] {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((name) => name.includes(".sql.gz.partial-"))
    .map((name) => resolve(backupDir, name))
    .sort();
}

function readInvalidBackupFiles(backupDir: string): string[] {
  const markerFile = resolve(backupDir, BACKUP_INTEGRITY_FAILURE_MARKER);
  if (!existsSync(markerFile)) return [];
  const parsed = JSON.parse(readFileSync(markerFile, "utf8")) as { invalidBackupFiles?: unknown };
  if (!Array.isArray(parsed.invalidBackupFiles)) return [];
  const resolvedBackupDir = resolve(backupDir);
  return parsed.invalidBackupFiles
    .filter((value): value is string => typeof value === "string")
    .map((value) => resolve(value))
    .filter((value) => {
      const relativePath = relative(resolvedBackupDir, value);
      return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath) && existsSync(value);
    })
    .sort();
}

export function inspectDatabaseBackupHealth(
  opts: InspectDatabaseBackupHealthOptions,
): DatabaseBackupHealthStatus {
  const warnings: DatabaseBackupHealthWarning[] = [];
  const now = opts.now ?? new Date();
  const maxAgeHours = Math.max(1, opts.maxAgeHours);

  let latestBackup: DatabaseBackupHealthStatus["latestBackup"] = null;
  let lastFailure: DatabaseBackupHealthStatus["lastFailure"] = null;
  let retainedIntermediateFiles: string[] = [];
  let invalidBackupFiles: string[] = [];

  try {
    latestBackup = findLatestBackup(opts.backupDir, now.getTime());
    lastFailure = readLastFailure(alertFileCandidates(opts));
    retainedIntermediateFiles = findRetainedIntermediateFiles(opts.backupDir);
    invalidBackupFiles = readInvalidBackupFiles(opts.backupDir);

    if (!latestBackup) {
      warnings.push({
        code: "database_backup_missing",
        message: `No .sql.gz database backups found in ${opts.backupDir}.`,
      });
    } else if (latestBackup.ageHours > maxAgeHours) {
      warnings.push({
        code: "database_backup_stale",
        message: `Latest database backup is ${latestBackup.ageHours}h old, exceeding ${maxAgeHours}h.`,
      });
    }

    if (lastFailure) {
      warnings.push({
        code: "database_backup_last_failure",
        message: lastFailure.message,
      });
    }
    if (retainedIntermediateFiles.length > 0) {
      warnings.push({
        code: "database_backup_incomplete",
        message: `Retained incomplete database backup intermediate(s): ${retainedIntermediateFiles.join(", ")}`,
      });
    }
    if (invalidBackupFiles.length > 0) {
      warnings.push({
        code: "database_backup_invalid_archive",
        message: `Integrity-invalid database backup archive(s) retained: ${invalidBackupFiles.join(", ")}`,
      });
    }
  } catch (error) {
    warnings.push({
      code: "database_backup_check_failed",
      message: `Database backup health check failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return {
    enabled: opts.enabled,
    status: warnings.length > 0 ? "warning" : "ok",
    backupDir: opts.backupDir,
    maxAgeHours,
    latestBackup,
    lastFailure,
    retainedIntermediateFiles,
    invalidBackupFiles,
    warnings,
  };
}

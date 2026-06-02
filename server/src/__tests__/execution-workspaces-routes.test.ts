import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  listSummaries: vi.fn(),
  getById: vi.fn(),
  getCloseReadiness: vi.fn(),
  update: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForExecutionWorkspace: vi.fn(),
  createRecorder: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockWorkspaceRuntime = vi.hoisted(() => ({
  cleanupExecutionWorkspaceArtifacts: vi.fn(async () => ({
    cleaned: true,
    cleanedPath: "/tmp/paperclip-shared-workspace",
    warnings: [],
  })),
  stopRuntimeServicesForExecutionWorkspace: vi.fn(async () => undefined),
}));

vi.mock("../services/index.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/workspace-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/workspace-runtime.js")>()),
  cleanupExecutionWorkspaceArtifacts: mockWorkspaceRuntime.cleanupExecutionWorkspaceArtifacts,
  stopRuntimeServicesForExecutionWorkspace: mockWorkspaceRuntime.stopRuntimeServicesForExecutionWorkspace,
}));

function createApp(db: any = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", executionWorkspaceRoutes(db));
  app.use(errorHandler);
  return app;
}

describe.sequential("execution workspace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspaceOperationService.createRecorder.mockReturnValue(null);
    mockExecutionWorkspaceService.list.mockResolvedValue([]);
    mockExecutionWorkspaceService.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
  });

  it("uses summary mode for lightweight workspace lookups", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/execution-workspaces?summary=true&reuseEligible=true");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    expect(mockExecutionWorkspaceService.listSummaries).toHaveBeenCalledWith("company-1", {
      projectId: undefined,
      projectWorkspaceId: undefined,
      issueId: undefined,
      status: undefined,
      reuseEligible: true,
    });
    expect(mockExecutionWorkspaceService.list).not.toHaveBeenCalled();
  });

  it("archives shared project-primary local records without marking record-only cleanup as failed", async () => {
    const now = new Date("2026-06-01T12:00:00.000Z");
    const existingWorkspace = {
      id: "execution-workspace-1",
      companyId: "company-1",
      projectId: null,
      projectWorkspaceId: null,
      sourceIssueId: "issue-1",
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Shared primary",
      status: "active",
      cwd: "/tmp/paperclip-shared-workspace",
      repoUrl: null,
      baseRef: "main",
      branchName: null,
      providerType: "local_fs",
      providerRef: null,
      derivedFromExecutionWorkspaceId: null,
      lastUsedAt: now,
      openedAt: now,
      closedAt: null,
      cleanupEligibleAt: null,
      cleanupReason: null,
      config: {
        provisionCommand: null,
        teardownCommand: null,
        cleanupCommand: null,
        workspaceRuntime: null,
        desiredState: null,
        serviceStates: null,
      },
      metadata: {
        createdByRuntime: true,
      },
      runtimeServices: [],
      createdAt: now,
      updatedAt: now,
    };
    const archivedWorkspace = {
      ...existingWorkspace,
      status: "archived",
      closedAt: now,
    };
    mockExecutionWorkspaceService.getById.mockResolvedValue(existingWorkspace);
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      workspaceId: existingWorkspace.id,
      state: "ready",
      blockingReasons: [],
      warnings: [],
      plannedActions: [{ kind: "archive_record" }],
    });
    mockExecutionWorkspaceService.update.mockResolvedValueOnce(archivedWorkspace);

    const db = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => undefined),
        })),
      })),
    };

    const res = await request(createApp(db))
      .patch(`/api/execution-workspaces/${existingWorkspace.id}`)
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("archived");
    expect(mockWorkspaceRuntime.cleanupExecutionWorkspaceArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      workspace: existingWorkspace,
      projectWorkspace: null,
      cleanupCommand: null,
      teardownCommand: null,
    }));
    expect(mockExecutionWorkspaceService.update).toHaveBeenCalledTimes(1);
    expect(mockExecutionWorkspaceService.update).not.toHaveBeenCalledWith(
      existingWorkspace.id,
      expect.objectContaining({ status: "cleanup_failed" }),
    );
  });
});

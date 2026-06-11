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
const mockStopRuntimeServicesForExecutionWorkspace = vi.hoisted(() => vi.fn(async () => undefined));
const mockCleanupExecutionWorkspaceArtifacts = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/workspace-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../services/workspace-runtime.js")>(
    "../services/workspace-runtime.js",
  );
  return {
    ...actual,
    cleanupExecutionWorkspaceArtifacts: mockCleanupExecutionWorkspaceArtifacts,
    stopRuntimeServicesForExecutionWorkspace: mockStopRuntimeServicesForExecutionWorkspace,
  };
});

function createMockDb() {
  return {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    })),
  };
}

function createApp() {
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
  app.use("/api", executionWorkspaceRoutes(createMockDb() as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("execution workspace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspaceOperationService.createRecorder.mockReturnValue({});
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

  it("archives shared record-only workspace sessions without requiring cwd deletion", async () => {
    const openedAt = new Date("2026-06-10T10:00:00.000Z");
    const existing = {
      id: "workspace-shared",
      companyId: "company-1",
      projectId: "project-1",
      projectWorkspaceId: "project-workspace-1",
      sourceIssueId: "issue-1",
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Shared session",
      status: "active",
      cwd: "/tmp/shared-project",
      repoUrl: null,
      baseRef: null,
      branchName: null,
      providerType: "local_fs",
      providerRef: "/tmp/shared-project",
      derivedFromExecutionWorkspaceId: null,
      lastUsedAt: openedAt,
      openedAt,
      closedAt: null,
      cleanupEligibleAt: null,
      cleanupReason: null,
      config: null,
      metadata: null,
      runtimeServices: [],
      createdAt: openedAt,
      updatedAt: openedAt,
    };
    const archived = {
      ...existing,
      status: "archived",
      closedAt: new Date("2026-06-10T10:05:00.000Z"),
    };
    mockExecutionWorkspaceService.getById.mockResolvedValue(existing);
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      workspaceId: existing.id,
      state: "ready_with_warnings",
      blockingReasons: [],
      warnings: ["Shared workspace archive is record-only."],
      linkedIssues: [],
      plannedActions: [
        {
          kind: "archive_record",
          label: "Archive workspace record",
          description: "Archive only",
          command: null,
        },
      ],
      isDestructiveCloseAllowed: true,
      isSharedWorkspace: true,
      isProjectPrimaryWorkspace: true,
      git: null,
      runtimeServices: [],
    });
    mockExecutionWorkspaceService.update.mockResolvedValue(archived);

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-shared")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("archived");
    expect(res.body.closedAt).toBeTruthy();
    expect(mockStopRuntimeServicesForExecutionWorkspace).toHaveBeenCalledWith({
      db: expect.anything(),
      executionWorkspaceId: existing.id,
      workspaceCwd: existing.cwd,
    });
    expect(mockCleanupExecutionWorkspaceArtifacts).not.toHaveBeenCalled();
    expect(mockExecutionWorkspaceService.update).toHaveBeenCalledTimes(1);
    expect(mockExecutionWorkspaceService.update).toHaveBeenCalledWith("workspace-shared", expect.objectContaining({
      status: "archived",
      cleanupReason: null,
      closedAt: expect.any(Date),
    }));
  });

  it("keeps isolated artifact cleanup failures in cleanup_failed", async () => {
    const openedAt = new Date("2026-06-10T10:00:00.000Z");
    const existing = {
      id: "workspace-isolated",
      companyId: "company-1",
      projectId: null,
      projectWorkspaceId: null,
      sourceIssueId: "issue-1",
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Isolated session",
      status: "active",
      cwd: "/tmp/worktree",
      repoUrl: "https://example.com/repo.git",
      baseRef: "main",
      branchName: "issue-1",
      providerType: "git_worktree",
      providerRef: "/tmp/worktree",
      derivedFromExecutionWorkspaceId: null,
      lastUsedAt: openedAt,
      openedAt,
      closedAt: null,
      cleanupEligibleAt: null,
      cleanupReason: null,
      config: null,
      metadata: null,
      runtimeServices: [],
      createdAt: openedAt,
      updatedAt: openedAt,
    };
    const archived = {
      ...existing,
      status: "archived",
      closedAt: new Date("2026-06-10T10:05:00.000Z"),
    };
    const cleanupFailed = {
      ...archived,
      status: "cleanup_failed",
      cleanupReason: null,
    };
    mockExecutionWorkspaceService.getById.mockResolvedValue(existing);
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      workspaceId: existing.id,
      state: "ready",
      blockingReasons: [],
      warnings: [],
      linkedIssues: [],
      plannedActions: [
        {
          kind: "archive_record",
          label: "Archive workspace record",
          description: "Archive record",
          command: null,
        },
        {
          kind: "git_worktree_remove",
          label: "Remove git worktree",
          description: "Remove worktree",
          command: "git worktree remove --force /tmp/worktree",
        },
      ],
      isDestructiveCloseAllowed: true,
      isSharedWorkspace: false,
      isProjectPrimaryWorkspace: false,
      git: null,
      runtimeServices: [],
    });
    mockExecutionWorkspaceService.update
      .mockResolvedValueOnce(archived)
      .mockResolvedValueOnce(cleanupFailed);
    mockCleanupExecutionWorkspaceArtifacts.mockResolvedValue({
      cleanedPath: "/tmp/worktree",
      cleaned: false,
      warnings: [],
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-isolated")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cleanup_failed");
    expect(mockCleanupExecutionWorkspaceArtifacts).toHaveBeenCalledTimes(1);
    expect(mockExecutionWorkspaceService.update).toHaveBeenLastCalledWith("workspace-isolated", expect.objectContaining({
      status: "cleanup_failed",
      closedAt: expect.any(Date),
    }));
  });
});

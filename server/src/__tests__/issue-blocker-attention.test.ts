import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { buildIssueGraphLivenessIncidentKey } from "../services/recovery/origins.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue blocker attention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue blocker attention", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-blocker-attention-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix = "PBA") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const pausedAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: `${prefix} Agent`,
        role: "engineer",
        status: "idle",
      },
      {
        id: pausedAgentId,
        companyId,
        name: `${prefix} Paused`,
        role: "engineer",
        status: "paused",
      },
    ]);
    return { companyId, agentId, pausedAgentId };
  }

  async function insertIssue(input: {
    companyId: string;
    id?: string;
    identifier: string;
    title: string;
    status: string;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    originKind?: string | null;
    originId?: string | null;
    originFingerprint?: string | null;
    executionState?: Record<string, unknown> | null;
    description?: string | null;
  }) {
    const id = input.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.title,
      status: input.status,
      priority: "medium",
      parentId: input.parentId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      originKind: input.originKind ?? "manual",
      originId: input.originId ?? null,
      originFingerprint: input.originFingerprint ?? "default",
      executionState: input.executionState ?? null,
      description: input.description ?? null,
    });
    return id;
  }

  async function block(input: { companyId: string; blockerIssueId: string; blockedIssueId: string }) {
    await db.insert(issueRelations).values({
      companyId: input.companyId,
      issueId: input.blockerIssueId,
      relatedIssueId: input.blockedIssueId,
      type: "blocks",
    });
  }

  async function activeRun(input: { companyId: string; agentId: string; issueId: string; status?: string; current?: boolean }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status ?? "running",
      contextSnapshot: { issueId: input.issueId },
    });
    if (input.current !== false) {
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, input.issueId));
    }
    return runId;
  }

  it("classifies a blocked parent as covered when its child has a running execution path", async () => {
    const { companyId, agentId } = await createCompany("PBC");
    const parentId = await insertIssue({ companyId, identifier: "PBC-1", title: "Parent", status: "blocked" });
    const childId = await insertIssue({
      companyId,
      identifier: "PBC-2",
      title: "Running child",
      status: "todo",
      parentId,
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: childId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: childId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_child",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBC-2",
    });
  });

  it("classifies an assigned backlog blocker leaf without a waiting path as attention-needed", async () => {
    const { companyId, agentId } = await createCompany("PBB");
    const parentId = await insertIssue({ companyId, identifier: "PBB-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBB-2",
      title: "Parked assigned blocker",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      stalledBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBB-2",
    });
  });

  it("treats a human-owned backlog blocker as a covered waiting path", async () => {
    const { companyId } = await createCompany("PBU");
    const parentId = await insertIssue({ companyId, identifier: "PBU-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBU-2",
      title: "Human-owned parked blocker",
      status: "backlog",
      assigneeUserId: "board-user-1",
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBU-2",
    });
  });

  it("keeps mixed blockers attention-required when any path lacks active work", async () => {
    const { companyId, agentId } = await createCompany("PBM");
    const parentId = await insertIssue({ companyId, identifier: "PBM-1", title: "Parent", status: "blocked" });
    const activeChildId = await insertIssue({
      companyId,
      identifier: "PBM-2",
      title: "Running child",
      status: "todo",
      parentId,
      assigneeAgentId: agentId,
    });
    const idleBlockerId = await insertIssue({
      companyId,
      identifier: "PBM-3",
      title: "Idle blocker",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: activeChildId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: idleBlockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: activeChildId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 1,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBM-3",
    });
  });

  it("ignores cancelled direct children when counting unresolved blocker attention", async () => {
    const { companyId, agentId } = await createCompany("PBD");
    const parentId = await insertIssue({ companyId, identifier: "PBD-1", title: "Parent", status: "blocked" });
    const activeBlockerOneId = await insertIssue({
      companyId,
      identifier: "PBD-2",
      title: "Running dependency one",
      status: "todo",
      assigneeAgentId: agentId,
    });
    const activeBlockerTwoId = await insertIssue({
      companyId,
      identifier: "PBD-3",
      title: "Running dependency two",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await insertIssue({
      companyId,
      identifier: "PBD-4",
      title: "Cancelled child",
      status: "cancelled",
      parentId,
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: activeBlockerOneId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: activeBlockerTwoId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: activeBlockerOneId });
    await activeRun({ companyId, agentId, issueId: activeBlockerTwoId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 2,
      stalledBlockerCount: 0,
      attentionBlockerCount: 0,
    });
    expect(parent?.blockerAttention?.sampleBlockerIdentifier).not.toBe("PBD-4");
  });

  it("covers recursive blocker chains when the downstream leaf has active work", async () => {
    const { companyId, agentId } = await createCompany("PBR");
    const parentId = await insertIssue({ companyId, identifier: "PBR-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({ companyId, identifier: "PBR-2", title: "Blocked dependency", status: "blocked" });
    const leafId = await insertIssue({
      companyId,
      identifier: "PBR-3",
      title: "Running leaf",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: blockerId });
    await activeRun({ companyId, agentId, issueId: leafId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBR-3",
    });
  });

  it("classifies a 300-link blocker chain identically for single and bulk reads", async () => {
    const { companyId } = await createCompany("PBDP");
    const chainRows = Array.from({ length: 301 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      identifier: `PBDP-${index + 1}`,
      title: index === 300 ? "Terminal human review" : `Blocked chain ${index + 1}`,
      status: index === 300 ? "in_review" as const : "blocked" as const,
      priority: "medium" as const,
      assigneeUserId: index === 300 ? "board-reviewer" : null,
      originKind: "manual",
      originFingerprint: `deep-${index}`,
    }));
    await db.insert(issues).values(chainRows);
    await db.insert(issueRelations).values(chainRows.slice(1).map((row, index) => ({
      companyId,
      issueId: row.id,
      relatedIssueId: chainRows[index]!.id,
      type: "blocks" as const,
    })));

    const root = await svc.getById(chainRows[0]!.id);
    expect(root).not.toBeNull();
    const singleAttention = (await svc.listBlockerAttention(companyId, [root!])).get(chainRows[0]!.id);
    const bulkRoot = (await svc.list(companyId, { status: "blocked" }))
      .find((issue) => issue.id === chainRows[0]!.id);
    const relations = await svc.getRelationSummaries(chainRows[0]!.id);

    expect(singleAttention).toEqual(bulkRoot?.blockerAttention);
    expect(singleAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBDP-301",
    });
    expect(relations.blockedBy).toHaveLength(1);
    expect(relations.blockedBy[0]?.terminalBlockers).toEqual([
      expect.objectContaining({ id: chainRows[300]!.id, identifier: "PBDP-301" }),
    ]);
  }, 15_000);

  it("classifies a chain at the exact traversal depth ceiling identically for single and bulk reads", async () => {
    const { companyId } = await createCompany("PBRC");
    const chainRows = Array.from({ length: 513 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      identifier: `PBRC-${index + 1}`,
      title: index === 512 ? "Terminal human review" : `Blocked chain ${index + 1}`,
      status: index === 512 ? "in_review" as const : "blocked" as const,
      priority: "medium" as const,
      assigneeUserId: index === 512 ? "board-reviewer" : null,
      originKind: "manual",
      originFingerprint: `root-ceiling-${index}`,
    }));
    await db.insert(issues).values(chainRows);
    await db.insert(issueRelations).values(chainRows.slice(1).map((row, index) => ({
      companyId,
      issueId: row.id,
      relatedIssueId: chainRows[index]!.id,
      type: "blocks" as const,
    })));

    const root = await svc.getById(chainRows[0]!.id);
    const singleAttention = (await svc.listBlockerAttention(companyId, [root!])).get(chainRows[0]!.id);
    const bulkRoot = (await svc.list(companyId, { status: "blocked" }))
      .find((issue) => issue.id === chainRows[0]!.id);
    const relations = await svc.getRelationSummaries(chainRows[0]!.id);

    expect(singleAttention).toEqual(bulkRoot?.blockerAttention);
    expect(singleAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBRC-513",
    });
    expect(relations.blockedBy).toHaveLength(1);
    expect(relations.blockedBy[0]?.terminalBlockers).toEqual([
      expect.objectContaining({ id: chainRows[512]!.id, identifier: "PBRC-513" }),
    ]);
  }, 20_000);

  it("keeps exact-depth classification shape-independent with a wide intermediate frontier", async () => {
    const { companyId } = await createCompany("PBMW");
    const chainRows = Array.from({ length: 513 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      identifier: `PBMW-${index + 1}`,
      title: index === 512 ? "Terminal human review" : `Blocked chain ${index + 1}`,
      status: index === 512 ? "in_review" as const : "blocked" as const,
      priority: "medium" as const,
      assigneeUserId: index === 512 ? "board-reviewer" : null,
      originKind: "manual",
      originFingerprint: `mixed-chain-${index}`,
    }));
    const wideRows = Array.from({ length: 500 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      identifier: `PBMW-W${index + 1}`,
      title: `Covered terminal ${index + 1}`,
      status: "in_review" as const,
      priority: "medium" as const,
      assigneeUserId: "board-reviewer",
      originKind: "manual",
      originFingerprint: `mixed-wide-${index}`,
    }));
    for (const rows of [chainRows, wideRows]) {
      for (let index = 0; index < rows.length; index += 500) {
        await db.insert(issues).values(rows.slice(index, index + 500));
      }
    }
    await db.insert(issueRelations).values([
      ...chainRows.slice(1).map((row, index) => ({
        companyId,
        issueId: row.id,
        relatedIssueId: chainRows[index]!.id,
        type: "blocks" as const,
      })),
      ...wideRows.map((row) => ({
        companyId,
        issueId: row.id,
        relatedIssueId: chainRows[1]!.id,
        type: "blocks" as const,
      })),
    ]);

    const root = await svc.getById(chainRows[0]!.id);
    const singleAttention = (await svc.listBlockerAttention(companyId, [root!])).get(chainRows[0]!.id);
    const bulkRoot = (await svc.list(companyId, { status: "blocked" }))
      .find((issue) => issue.id === chainRows[0]!.id);
    const relations = await svc.getRelationSummaries(chainRows[0]!.id);
    const terminalBlockers = relations.blockedBy[0]?.terminalBlockers;

    expect(singleAttention).toEqual(bulkRoot?.blockerAttention);
    expect(singleAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
    });
    expect(terminalBlockers).toHaveLength(501);
    expect(terminalBlockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: chainRows[512]!.id, identifier: "PBMW-513" }),
      ...wideRows.map((row) => expect.objectContaining({ id: row.id, identifier: row.identifier })),
    ]));
  }, 30_000);

  it("fails closed per root when a chain exceeds the traversal depth budget", async () => {
    const { companyId } = await createCompany("PBRB");
    const chainRows = Array.from({ length: 514 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      identifier: `PBRB-${index + 1}`,
      title: index === 513 ? "Terminal human review" : `Blocked chain ${index + 1}`,
      status: index === 513 ? "in_review" as const : "blocked" as const,
      priority: "medium" as const,
      assigneeUserId: index === 513 ? "board-reviewer" : null,
      originKind: "manual",
      originFingerprint: `root-budget-${index}`,
    }));
    await db.insert(issues).values(chainRows);
    await db.insert(issueRelations).values(chainRows.slice(1).map((row, index) => ({
      companyId,
      issueId: row.id,
      relatedIssueId: chainRows[index]!.id,
      type: "blocks" as const,
    })));

    const root = await svc.getById(chainRows[0]!.id);
    const singleAttention = (await svc.listBlockerAttention(companyId, [root!])).get(chainRows[0]!.id);
    const bulkRoot = (await svc.list(companyId, { status: "blocked" }))
      .find((issue) => issue.id === chainRows[0]!.id);
    const relations = await svc.getRelationSummaries(chainRows[0]!.id);

    expect(singleAttention).toEqual(bulkRoot?.blockerAttention);
    expect(singleAttention).toMatchObject({
      state: "needs_attention",
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
    });
    expect(relations.blockedBy).toHaveLength(1);
    expect(relations.blockedBy[0]?.terminalBlockers).toBeUndefined();
  }, 20_000);

  it("fails closed when an over-depth path rejoins a shallower shared terminal", async () => {
    const { companyId } = await createCompany("PBSH");
    const chainRows = Array.from({ length: 514 }, (_, index) => ({
      id: `51300000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      companyId,
      identifier: `PBSH-${index + 1}`,
      title: index === 513 ? "Shared terminal human review" : `Blocked chain ${index + 1}`,
      status: index === 513 ? "in_review" as const : "blocked" as const,
      priority: "medium" as const,
      assigneeUserId: index === 513 ? "board-reviewer" : null,
      originKind: "manual",
      originFingerprint: `shared-depth-${index}`,
    }));
    await db.insert(issues).values(chainRows);
    await db.insert(issueRelations).values([
      ...chainRows.slice(1).map((row, index) => ({
        companyId,
        issueId: row.id,
        relatedIssueId: chainRows[index]!.id,
        type: "blocks" as const,
      })),
      {
        companyId,
        issueId: chainRows[513]!.id,
        relatedIssueId: chainRows[1]!.id,
        type: "blocks" as const,
      },
    ]);

    const root = await svc.getById(chainRows[0]!.id);
    const singleAttention = (await svc.listBlockerAttention(companyId, [root!])).get(chainRows[0]!.id);
    const bulkRoot = (await svc.list(companyId, { status: "blocked" }))
      .find((issue) => issue.id === chainRows[0]!.id);
    const relations = await svc.getRelationSummaries(chainRows[0]!.id);

    expect(singleAttention).toEqual(bulkRoot?.blockerAttention);
    expect(singleAttention).toMatchObject({
      state: "needs_attention",
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
    });
    expect(relations.blockedBy).toHaveLength(1);
    expect(relations.blockedBy[0]?.terminalBlockers).toBeUndefined();
  }, 20_000);

  it("fails closed for an explicit blocker cycle", async () => {
    const { companyId } = await createCompany("PBCY");
    const rootId = await insertIssue({ companyId, identifier: "PBCY-1", title: "Cycle root", status: "blocked" });
    const middleId = await insertIssue({ companyId, identifier: "PBCY-2", title: "Cycle middle", status: "blocked" });
    const tailId = await insertIssue({ companyId, identifier: "PBCY-3", title: "Cycle tail", status: "blocked" });
    await block({ companyId, blockerIssueId: middleId, blockedIssueId: rootId });
    await block({ companyId, blockerIssueId: tailId, blockedIssueId: middleId });
    // Insert directly to exercise defensive read behavior for legacy/corrupt graphs;
    // normal service writes reject this closing edge.
    await block({ companyId, blockerIssueId: rootId, blockedIssueId: tailId });

    const root = await svc.getById(rootId);
    const attention = (await svc.listBlockerAttention(companyId, [root!])).get(rootId);
    const bulkRoot = (await svc.list(companyId, { status: "blocked" }))
      .find((issue) => issue.id === rootId);
    const relations = await svc.getRelationSummaries(rootId);

    expect(attention).toEqual(bulkRoot?.blockerAttention);
    expect(attention).toMatchObject({
      state: "needs_attention",
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
    });
    expect(relations.blockedBy[0]?.terminalBlockers).toBeUndefined();
  });

  it("keeps attention and terminal expansion fail-closed when a linear graph exhausts traversal work", async () => {
    const { companyId } = await createCompany("PBBG");
    const rootId = await insertIssue({ companyId, identifier: "PBBG-1", title: "Budget root", status: "blocked" });
    const blockerRows = Array.from({ length: 2000 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      identifier: `PBBG-${index + 2}`,
      title: index === 1999 ? "Terminal human review" : `Blocked chain ${index + 1}`,
      status: index === 1999 ? "in_review" : "blocked",
      priority: "medium" as const,
      assigneeUserId: index === 1999 ? "board-reviewer" : null,
      originKind: "manual",
      originFingerprint: `budget-${index}`,
    }));
    await db.insert(issues).values(blockerRows);
    await db.insert(issueRelations).values(blockerRows.map((row, index) => ({
      companyId,
      issueId: row.id,
      relatedIssueId: index === 0 ? rootId : blockerRows[index - 1]!.id,
      type: "blocks" as const,
    })));

    const root = await svc.getById(rootId);
    const attention = (await svc.listBlockerAttention(companyId, [root!])).get(rootId);
    const bulkRoot = (await svc.list(companyId, { status: "blocked" }))
      .find((issue) => issue.id === rootId);
    const relations = await svc.getRelationSummaries(rootId);

    expect(attention).toEqual(bulkRoot?.blockerAttention);
    expect(attention).toMatchObject({
      state: "needs_attention",
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
    });
    expect(relations.blockedBy).toHaveLength(1);
    expect(relations.blockedBy[0]?.terminalBlockers).toBeUndefined();
  }, 30_000);

  it("bounds a wide frontier by node and edge work budgets with single/bulk parity", async () => {
    const { companyId } = await createCompany("PBWF");
    const rootId = await insertIssue({ companyId, identifier: "PBWF-1", title: "Wide root", status: "blocked" });
    const blockerRows = Array.from({ length: 4001 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      identifier: `PBWF-${index + 2}`,
      title: `Wide blocker ${index + 1}`,
      status: "todo" as const,
      priority: "medium" as const,
      assigneeUserId: "board-reviewer",
      originKind: "manual",
      originFingerprint: `wide-${index}`,
    }));
    for (let index = 0; index < blockerRows.length; index += 500) {
      await db.insert(issues).values(blockerRows.slice(index, index + 500));
    }
    const relationRows = blockerRows.map((row) => ({
      companyId,
      issueId: row.id,
      relatedIssueId: rootId,
      type: "blocks" as const,
    }));
    for (let index = 0; index < relationRows.length; index += 500) {
      await db.insert(issueRelations).values(relationRows.slice(index, index + 500));
    }

    const root = await svc.getById(rootId);
    const singleAttention = (await svc.listBlockerAttention(companyId, [root!])).get(rootId);
    const bulkRoot = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === rootId);
    const relations = await svc.getRelationSummaries(rootId);

    expect(singleAttention).toEqual(bulkRoot?.blockerAttention);
    expect(singleAttention).toMatchObject({
      state: "needs_attention",
      unresolvedBlockerCount: 4000,
      coveredBlockerCount: 0,
      attentionBlockerCount: 4000,
    });
    expect(relations.blockedBy).toHaveLength(4001);
    expect(relations.blockedBy.every((blocker) => blocker.terminalBlockers === undefined)).toBe(true);
  }, 30_000);

  it("classifies a shared blocker DAG once and preserves terminal agreement", async () => {
    const { companyId } = await createCompany("PBDG");
    const rootId = await insertIssue({ companyId, identifier: "PBDG-1", title: "DAG root", status: "blocked" });
    const layers: string[][] = [];
    for (let layer = 0; layer < 22; layer += 1) {
      layers.push([
        await insertIssue({ companyId, identifier: `PBDG-${layer * 2 + 2}`, title: `Layer ${layer} A`, status: "blocked" }),
        await insertIssue({ companyId, identifier: `PBDG-${layer * 2 + 3}`, title: `Layer ${layer} B`, status: "blocked" }),
      ]);
    }
    const terminalId = await insertIssue({
      companyId,
      identifier: "PBDG-46",
      title: "Terminal human review",
      status: "in_review",
      assigneeUserId: "board-reviewer",
    });
    for (const blockerId of layers[0]!) {
      await block({ companyId, blockerIssueId: blockerId, blockedIssueId: rootId });
    }
    for (let layer = 0; layer < layers.length - 1; layer += 1) {
      for (const blockedIssueId of layers[layer]!) {
        for (const blockerIssueId of layers[layer + 1]!) {
          await block({ companyId, blockerIssueId, blockedIssueId });
        }
      }
    }
    for (const blockedIssueId of layers[layers.length - 1]!) {
      await block({ companyId, blockerIssueId: terminalId, blockedIssueId });
    }

    const root = await svc.getById(rootId);
    const singleAttention = (await svc.listBlockerAttention(companyId, [root!])).get(rootId);
    const bulkRoot = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === rootId);
    const relations = await svc.getRelationSummaries(rootId);

    expect(singleAttention).toEqual(bulkRoot?.blockerAttention);
    expect(singleAttention).toMatchObject({
      state: "covered",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 2,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBDG-46",
    });
    expect(relations.blockedBy).toHaveLength(2);
    for (const blocker of relations.blockedBy) {
      expect(blocker.terminalBlockers).toEqual([
        expect.objectContaining({ id: terminalId, identifier: "PBDG-46" }),
      ]);
    }
  }, 10_000);

  it("does not let another company's active run cover the blocker", async () => {
    const { companyId, agentId } = await createCompany("PBS");
    const other = await createCompany("PBT");
    const parentId = await insertIssue({ companyId, identifier: "PBS-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBS-2",
      title: "Same-company blocker",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId: other.companyId, agentId: other.agentId, issueId: blockerId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBS-2",
    });
  });

  it("does not cover a blocker from a stale run the issue no longer owns", async () => {
    const { companyId, agentId } = await createCompany("PBX");
    const parentId = await insertIssue({ companyId, identifier: "PBX-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBX-2",
      title: "Previously running blocker",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: blockerId, current: false });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBX-2",
    });
  });

  it("flags a chain whose leaf is in_review without an action path as stalled", async () => {
    const { companyId, agentId } = await createCompany("PBV");
    const parentId = await insertIssue({ companyId, identifier: "PBV-1", title: "Parent", status: "blocked" });
    const reviewLeafId = await insertIssue({
      companyId,
      identifier: "PBV-2",
      title: "Stalled review leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: reviewLeafId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "stalled",
      reason: "stalled_review",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      stalledBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBV-2",
      sampleStalledBlockerIdentifier: "PBV-2",
    });
  });

  it("does not flag an in_review leaf as stalled when an active run is still progressing it", async () => {
    const { companyId, agentId } = await createCompany("PBW");
    const parentId = await insertIssue({ companyId, identifier: "PBW-1", title: "Parent", status: "blocked" });
    const reviewLeafId = await insertIssue({
      companyId,
      identifier: "PBW-2",
      title: "Active review leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: reviewLeafId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: reviewLeafId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      stalledBlockerCount: 0,
    });
  });

  it("flags a deep chain whose leaf is stalled in_review through multiple layers", async () => {
    const { companyId, agentId } = await createCompany("PBZ");
    const rootId = await insertIssue({ companyId, identifier: "PBZ-1", title: "Root", status: "blocked" });
    const midId = await insertIssue({ companyId, identifier: "PBZ-2", title: "Mid blocker", status: "blocked" });
    const leafId = await insertIssue({
      companyId,
      identifier: "PBZ-3",
      title: "Stalled leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: midId, blockedIssueId: rootId });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: midId });

    const root = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === rootId);

    expect(root?.blockerAttention).toMatchObject({
      state: "stalled",
      reason: "stalled_review",
      stalledBlockerCount: 1,
      sampleStalledBlockerIdentifier: "PBZ-3",
    });
  });

  it("prefers needs_attention over stalled when the chain also has a hard attention case", async () => {
    const { companyId, agentId } = await createCompany("PBQ");
    const parentId = await insertIssue({ companyId, identifier: "PBQ-1", title: "Parent", status: "blocked" });
    const reviewLeafId = await insertIssue({
      companyId,
      identifier: "PBQ-2",
      title: "Stalled review leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    const cancelledLeafId = await insertIssue({
      companyId,
      identifier: "PBQ-3",
      title: "Cancelled blocker",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: reviewLeafId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: cancelledLeafId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      coveredBlockerCount: 0,
      stalledBlockerCount: 1,
      attentionBlockerCount: 1,
      sampleStalledBlockerIdentifier: "PBQ-2",
    });
  });

  it("treats open liveness escalation blockers as covered waiting paths", async () => {
    const { companyId, agentId } = await createCompany("PBL");
    const parentId = await insertIssue({ companyId, identifier: "PBL-1", title: "Parent", status: "blocked" });
    const cancelledLeafId = await insertIssue({
      companyId,
      identifier: "PBL-2",
      title: "Cancelled blocker",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    const incidentKey = [
      "harness_liveness",
      companyId,
      parentId,
      "blocked_by_cancelled_issue",
      cancelledLeafId,
    ].join(":");
    const escalationId = await insertIssue({
      companyId,
      identifier: "PBL-3",
      title: "Liveness escalation",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "harness_liveness_escalation",
      originId: incidentKey,
      originFingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_cancelled_issue",
        cancelledLeafId,
      ].join(":"),
    });
    await block({ companyId, blockerIssueId: cancelledLeafId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: escalationId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked,todo" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 2,
      attentionBlockerCount: 0,
    });
  });

  it("does not treat a scheduled retry as actively covered work", async () => {
    const { companyId, agentId } = await createCompany("PBY");
    const parentId = await insertIssue({ companyId, identifier: "PBY-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBY-2",
      title: "Retrying blocker",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: blockerId, status: "scheduled_retry" });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBY-2",
    });
  });

  it("returns blocked inbox attention for an unassigned blocker leaf and supports count/search", async () => {
    const { companyId } = await createCompany("BIA");
    const parentId = await insertIssue({ companyId, identifier: "BIA-1", title: "Blocked source", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "BIA-2",
      title: "Unassigned leaf",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const rows = await svc.list(companyId, { attention: "blocked", q: "BIA-2" });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(parentId);
    expect(rows[0]?.blockedBy).toEqual([
      expect.objectContaining({ id: blockerId, identifier: "BIA-2" }),
    ]);
    expect(rows[0]?.blockedInboxAttention).toMatchObject({
      kind: "blocked",
      state: "needs_attention",
      reason: "blocked_by_unassigned_issue",
      severity: "critical",
      owner: { type: "unknown", agentId: null, userId: null },
      action: { label: "Assign blocker" },
      leafIssue: { id: blockerId, identifier: "BIA-2" },
      redaction: { secretFieldsOmitted: true },
    });
    await expect(svc.count(companyId, { attention: "blocked" })).resolves.toBe(1);
  });

  it("redacts external wait details from blocked inbox payloads and search", async () => {
    const { companyId } = await createCompany("BIX");
    const owner = "Private Vendor Security Team";
    const action = "Send the confidential access token for customer Alpha";
    const issueId = await insertIssue({
      companyId,
      identifier: "BIX-1",
      title: "Blocked on vendor",
      status: "blocked",
      description: [
        "Public context stays visible.",
        `external owner: ${owner}`,
        `external action: ${action}`,
        "Continue after the vendor confirms receipt.",
      ].join("\n"),
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const issue = rows.find((row) => row.id === issueId);

    expect(issue?.description).toContain("Public context stays visible.");
    expect(issue?.description).toContain("Continue after the vendor confirms receipt.");
    expect(issue?.description).not.toContain(owner);
    expect(issue?.description).not.toContain(action);
    expect(issue?.blockedInboxAttention).toMatchObject({
      state: "external_wait",
      reason: "external_owner_action",
      owner: { type: "external", label: null },
      action: { label: "External owner action", detail: null },
      redaction: { externalDetailsRedacted: true, secretFieldsOmitted: true },
    });
    expect(JSON.stringify(issue?.blockedInboxAttention)).not.toContain(owner);
    expect(JSON.stringify(issue?.blockedInboxAttention)).not.toContain(action);

    await expect(svc.list(companyId, { attention: "blocked", q: owner })).resolves.toEqual([]);
    await expect(svc.count(companyId, { attention: "blocked", q: action })).resolves.toBe(0);
    await expect(svc.count(companyId, { attention: "blocked", q: "Public context" })).resolves.toBe(1);
  });

  it("excludes healthy active blockers from blocked inbox attention", async () => {
    const { companyId, agentId } = await createCompany("BIB");
    const parentId = await insertIssue({ companyId, identifier: "BIB-1", title: "Blocked source", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "BIB-2",
      title: "Running leaf",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: blockerId });

    expect(await svc.list(companyId, { attention: "blocked" })).toEqual([]);
  });

  it("classifies assigned backlog and invalid review leaves for blocked inbox attention", async () => {
    const { companyId, agentId, pausedAgentId } = await createCompany("BIC");
    const backlogParentId = await insertIssue({ companyId, identifier: "BIC-1", title: "Blocked by parked work", status: "blocked" });
    const backlogLeafId = await insertIssue({
      companyId,
      identifier: "BIC-2",
      title: "Parked blocker",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: backlogLeafId, blockedIssueId: backlogParentId });

    const reviewId = await insertIssue({
      companyId,
      identifier: "BIC-3",
      title: "Invalid review",
      status: "in_review",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: pausedAgentId },
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(backlogParentId)?.blockedInboxAttention).toMatchObject({
      reason: "blocked_by_assigned_backlog_issue",
      severity: "high",
      owner: { type: "agent", agentId },
      leafIssue: { id: backlogLeafId },
    });
    expect(byId.get(reviewId)?.blockedInboxAttention).toMatchObject({
      reason: "invalid_review_participant",
      severity: "critical",
      action: { label: "Repair review participant" },
    });
  });

  it("classifies recovery issues and missing successful-run dispositions", async () => {
    const { companyId, agentId } = await createCompany("BID");
    const sourceId = await insertIssue({ companyId, identifier: "BID-1", title: "Stopped source", status: "blocked" });
    const leafId = await insertIssue({ companyId, identifier: "BID-2", title: "Stopped leaf", status: "todo" });
    const recoveryId = await insertIssue({
      companyId,
      identifier: "BID-3",
      title: "Recovery issue",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "harness_liveness_escalation",
      originId: buildIssueGraphLivenessIncidentKey({
        companyId,
        issueId: sourceId,
        state: "blocked_by_unassigned_issue",
        blockerIssueId: leafId,
      }),
    });
    const handoffId = await insertIssue({
      companyId,
      identifier: "BID-4",
      title: "Needs disposition",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.successful_run_handoff_required",
      entityType: "issue",
      entityId: handoffId,
      agentId,
      details: { sourceRunId: randomUUID(), detectedProgressSummary: "Progress was made" },
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(recoveryId)?.blockedInboxAttention).toMatchObject({
      state: "recovery_open",
      reason: "open_recovery_issue",
      sourceIssue: { id: sourceId },
      leafIssue: { id: leafId },
      recoveryIssue: { id: recoveryId },
    });
    expect(byId.get(handoffId)?.blockedInboxAttention).toMatchObject({
      state: "missing_disposition",
      reason: "missing_successful_run_disposition",
      owner: { type: "agent", agentId },
      action: { label: "Choose disposition" },
    });
  });

  it("applies assigneeAgentId='null' as an IS NULL filter on the blocked-inbox path", async () => {
    const { companyId, agentId } = await createCompany("BAN");
    const unassignedParentId = await insertIssue({
      companyId,
      identifier: "BAN-1",
      title: "Unassigned blocked parent",
      status: "blocked",
    });
    const unassignedLeafId = await insertIssue({
      companyId,
      identifier: "BAN-2",
      title: "Unassigned leaf",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: unassignedLeafId, blockedIssueId: unassignedParentId });

    const assignedParentId = await insertIssue({
      companyId,
      identifier: "BAN-3",
      title: "Assigned blocked parent",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    const assignedLeafId = await insertIssue({
      companyId,
      identifier: "BAN-4",
      title: "Unassigned leaf for assigned parent",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: assignedLeafId, blockedIssueId: assignedParentId });

    const rows = await svc.list(companyId, { attention: "blocked", assigneeAgentId: "null" });
    expect(rows.map((row) => row.id)).toEqual([unassignedParentId]);

    await expect(svc.count(companyId, { attention: "blocked", assigneeAgentId: "null" })).resolves.toBe(1);
  });

  it("applies a UUID assigneeAgentId filter on the blocked-inbox path", async () => {
    const { companyId, agentId } = await createCompany("BAU");
    const unassignedParentId = await insertIssue({
      companyId,
      identifier: "BAU-1",
      title: "Unassigned blocked parent",
      status: "blocked",
    });
    const unassignedLeafId = await insertIssue({
      companyId,
      identifier: "BAU-2",
      title: "Unassigned leaf",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: unassignedLeafId, blockedIssueId: unassignedParentId });

    const assignedParentId = await insertIssue({
      companyId,
      identifier: "BAU-3",
      title: "Assigned blocked parent",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    const assignedLeafId = await insertIssue({
      companyId,
      identifier: "BAU-4",
      title: "Unassigned leaf for assigned parent",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: assignedLeafId, blockedIssueId: assignedParentId });

    const rows = await svc.list(companyId, { attention: "blocked", assigneeAgentId: agentId });
    expect(rows.map((row) => row.id)).toEqual([assignedParentId]);

    await expect(svc.count(companyId, { attention: "blocked", assigneeAgentId: agentId })).resolves.toBe(1);
  });

  it("rejects malformed assigneeAgentId filter values on the blocked-inbox path", async () => {
    const { companyId } = await createCompany("BAM");
    await expect(
      svc.list(companyId, { attention: "blocked", assigneeAgentId: "not-a-uuid" }),
    ).rejects.toThrow(/assigneeAgentId/i);
    await expect(
      svc.count(companyId, { attention: "blocked", assigneeAgentId: "not-a-uuid" }),
    ).rejects.toThrow(/assigneeAgentId/i);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  pluginJobRuns,
  pluginJobs,
  plugins,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { pluginJobStore } from "../services/plugin-job-store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("plugin job reliability guardrails", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-job-reliability-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginJobRuns);
    await db.delete(pluginJobs);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPluginJob() {
    const companyId = randomUUID();
    const pluginId = randomUUID();
    const jobId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `test-plugin-${pluginId}`,
      packageName: "test-plugin",
      version: "1.0.0",
      manifestJson: {
        id: "test-plugin",
        displayName: "Test Plugin",
        version: "1.0.0",
        apiVersion: 1,
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["jobs.schedule"],
      },
      status: "ready",
    });
    await db.insert(pluginJobs).values({
      id: jobId,
      pluginId,
      jobKey: "sync",
      schedule: "* * * * *",
      status: "active",
    });
    return { pluginId, jobId };
  }

  it("reuses the same durable run result for duplicate manual trigger submits", async () => {
    const { pluginId, jobId } = await seedPluginJob();
    const call = vi.fn().mockResolvedValue(undefined);
    const store = pluginJobStore(db);
    const scheduler = createPluginJobScheduler({
      db,
      jobStore: store,
      workerManager: {
        isRunning: (candidatePluginId: string) => candidatePluginId === pluginId,
        call,
      } as any,
    });

    const first = await scheduler.triggerJob(jobId, "manual", {
      idempotencyKey: "submit-1",
    });
    const second = await scheduler.triggerJob(jobId, "manual", {
      idempotencyKey: "submit-1",
    });

    expect(second).toEqual({ ...first, reused: true });
    expect(first.reused).toBe(false);
    expect(second.runId).toBe(first.runId);
    expect(await waitFor(() => call.mock.calls.length)).toBe(1);
  });

  it("moves failed async plugin job runs into the dead-letter lane", async () => {
    const { pluginId, jobId } = await seedPluginJob();
    const store = pluginJobStore(db);
    const scheduler = createPluginJobScheduler({
      db,
      jobStore: store,
      workerManager: {
        isRunning: (candidatePluginId: string) => candidatePluginId === pluginId,
        call: vi.fn().mockRejectedValue(new Error("worker crashed")),
      } as any,
    });

    const result = await scheduler.triggerJob(jobId, "manual", {
      idempotencyKey: "failing-submit",
    });

    const run = await waitFor(async () => {
      const current = await store.getRunById(result.runId);
      return current?.status === "dead_letter" ? current : null;
    });

    expect(run.status).toBe("dead_letter");
    expect(run.error).toBe("worker crashed");
    expect(run.idempotencyKey).toBe("failing-submit");
  });
});

async function waitFor<T>(
  read: () => Promise<T> | T,
  timeoutMs = 2_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T;
  do {
    lastValue = await read();
    if (lastValue) return lastValue as NonNullable<T>;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for condition; last value: ${String(lastValue)}`);
}

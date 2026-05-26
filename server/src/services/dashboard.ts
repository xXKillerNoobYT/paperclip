import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  companies,
  costEvents,
  heartbeatRuns,
  issueApprovals,
  issueThreadInteractions,
  issues,
  joinRequests,
} from "@paperclipai/db";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";

const DASHBOARD_RUN_ACTIVITY_DAYS = 14;
const DASHBOARD_BOARD_ACTION_LIMIT = 10;
const BOARD_ACTION_INTERACTION_KINDS = ["request_confirmation", "ask_user_questions", "suggest_tasks"];
const OPERATOR_REPAIR_PATTERN =
  /\b(config|configuration|credential|secret|token|auth|permission|access|runtime|setup|install|restart|retry|api key|environment)\b/i;

function isOperatorRepairRun(row: { errorCode: string | null; error: string | null; stderrExcerpt: string | null; stdoutExcerpt: string | null; nextAction: string | null }): boolean {
  return OPERATOR_REPAIR_PATTERN.test(
    [row.errorCode, row.error, row.stderrExcerpt, row.stdoutExcerpt, row.nextAction].filter(Boolean).join(" "),
  );
}

function humanizeActionType(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function summarizeInteraction(kind: string, summary: string | null, payload: unknown): string {
  if (summary?.trim()) return summary.trim();
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.prompt === "string" && record.prompt.trim()) return record.prompt.trim();
    if (typeof record.title === "string" && record.title.trim()) return record.title.trim();
    if (Array.isArray(record.questions)) {
      return `${record.questions.length} question${record.questions.length === 1 ? "" : "s"} awaiting a board answer`;
    }
    if (Array.isArray(record.tasks)) {
      return `${record.tasks.length} suggested task${record.tasks.length === 1 ? "" : "s"} awaiting board review`;
    }
  }
  return `${humanizeActionType(kind)} awaiting board response`;
}

function summarizeApproval(type: string, payload: unknown): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["summary", "reason", "description", "title"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return `${humanizeActionType(type)} awaiting board review`;
}

function formatUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function getUtcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function getRecentUtcDateKeys(now: Date, days: number): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const dayOffset = index - (days - 1);
    return formatUtcDateKey(new Date(todayUtc + dayOffset * 24 * 60 * 60 * 1000));
  });
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);
  return {
    summary: async (companyId: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const agentRows = await db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const taskRows = await db
        .select({ status: issues.status, count: sql<number>`count(*)` })
        .from(issues)
        .where(eq(issues.companyId, companyId))
        .groupBy(issues.status);

      const pendingApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .then((rows) => Number(rows[0]?.count ?? 0));

      const agentCounts: Record<string, number> = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        // "idle" agents are operational — count them as active
        const bucket = row.status === "idle" ? "active" : row.status;
        agentCounts[bucket] = (agentCounts[bucket] ?? 0) + count;
      }

      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };
      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      const now = new Date();
      const monthStart = getUtcMonthStart(now);
      const runActivityDays = getRecentUtcDateKeys(now, DASHBOARD_RUN_ACTIVITY_DAYS);
      const runActivityStart = new Date(`${runActivityDays[0]}T00:00:00.000Z`);
      const [{ monthSpend }] = await db
        .select({
          monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, monthStart),
          ),
        );

      const monthSpendCents = Number(monthSpend);
      const runActivityDayExpr = sql<string>`to_char(${heartbeatRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const runActivityRows = await db
        .select({
          date: runActivityDayExpr,
          status: heartbeatRuns.status,
          count: sql<number>`count(*)::double precision`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.createdAt, runActivityStart),
          ),
        )
        .groupBy(runActivityDayExpr, heartbeatRuns.status);

      const runActivity = new Map(
        runActivityDays.map((date) => [
          date,
          { date, succeeded: 0, failed: 0, other: 0, total: 0 },
        ]),
      );
      for (const row of runActivityRows) {
        const bucket = runActivity.get(row.date);
        if (!bucket) continue;
        const count = Number(row.count);
        if (row.status === "succeeded") bucket.succeeded += count;
        else if (row.status === "failed" || row.status === "timed_out") bucket.failed += count;
        else bucket.other += count;
        bucket.total += count;
      }

      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const budgetOverview = await budgets.overview(companyId);

      const approvalActionRows = await db
        .select({
          id: approvals.id,
          type: approvals.type,
          payload: approvals.payload,
          createdAt: approvals.createdAt,
          sourceIssueId: issues.id,
          sourceIssueIdentifier: issues.identifier,
          sourceIssueTitle: issues.title,
        })
        .from(approvals)
        .leftJoin(
          issueApprovals,
          and(
            eq(issueApprovals.companyId, approvals.companyId),
            eq(issueApprovals.approvalId, approvals.id),
          ),
        )
        .leftJoin(
          issues,
          and(eq(issues.companyId, approvals.companyId), eq(issues.id, issueApprovals.issueId)),
        )
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .orderBy(desc(approvals.createdAt))
        .limit(DASHBOARD_BOARD_ACTION_LIMIT);

      const interactionActionRows = await db
        .select({
          id: issueThreadInteractions.id,
          kind: issueThreadInteractions.kind,
          title: issueThreadInteractions.title,
          summary: issueThreadInteractions.summary,
          payload: issueThreadInteractions.payload,
          createdAt: issueThreadInteractions.createdAt,
          sourceIssueId: issues.id,
          sourceIssueIdentifier: issues.identifier,
          sourceIssueTitle: issues.title,
        })
        .from(issueThreadInteractions)
        .innerJoin(
          issues,
          and(
            eq(issues.companyId, issueThreadInteractions.companyId),
            eq(issues.id, issueThreadInteractions.issueId),
          ),
        )
        .where(
          and(
            eq(issueThreadInteractions.companyId, companyId),
            eq(issueThreadInteractions.status, "pending"),
            inArray(issueThreadInteractions.kind, BOARD_ACTION_INTERACTION_KINDS),
          ),
        )
        .orderBy(desc(issueThreadInteractions.createdAt))
        .limit(DASHBOARD_BOARD_ACTION_LIMIT);

      const failedRunRows = (
        await db
          .select({
            id: heartbeatRuns.id,
            agentId: heartbeatRuns.agentId,
            agentName: agents.name,
            status: heartbeatRuns.status,
            error: heartbeatRuns.error,
            errorCode: heartbeatRuns.errorCode,
            stderrExcerpt: heartbeatRuns.stderrExcerpt,
            stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
            nextAction: heartbeatRuns.nextAction,
            createdAt: heartbeatRuns.createdAt,
            updatedAt: heartbeatRuns.updatedAt,
          })
          .from(heartbeatRuns)
          .innerJoin(agents, and(eq(agents.companyId, heartbeatRuns.companyId), eq(agents.id, heartbeatRuns.agentId)))
          .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["failed", "timed_out"])))
          .orderBy(desc(heartbeatRuns.createdAt))
          .limit(DASHBOARD_BOARD_ACTION_LIMIT * 2)
      )
        .filter(isOperatorRepairRun)
        .slice(0, DASHBOARD_BOARD_ACTION_LIMIT);

      const joinRequestRows = await db
        .select({
          id: joinRequests.id,
          requestType: joinRequests.requestType,
          requestEmailSnapshot: joinRequests.requestEmailSnapshot,
          agentName: joinRequests.agentName,
          adapterType: joinRequests.adapterType,
          createdAt: joinRequests.createdAt,
          updatedAt: joinRequests.updatedAt,
        })
        .from(joinRequests)
        .where(and(eq(joinRequests.companyId, companyId), eq(joinRequests.status, "pending_approval")))
        .orderBy(desc(joinRequests.createdAt))
        .limit(DASHBOARD_BOARD_ACTION_LIMIT);

      const boardActions = [
        ...approvalActionRows.map((row) => ({
          id: row.id,
          kind: "approval" as const,
          sourceType: "approval" as const,
          severity: "warning" as const,
          actionType: row.type,
          sourceIssueId: row.sourceIssueId,
          sourceIssueIdentifier: row.sourceIssueIdentifier,
          sourceIssueTitle: row.sourceIssueTitle,
          title: `Approval: ${humanizeActionType(row.type)}`,
          summary: summarizeApproval(row.type, row.payload),
          reason: "Pending approval requires board review",
          actionLabel: "Review approval",
          href: `/approvals/${row.id}`,
          createdAt: row.createdAt,
          updatedAt: row.createdAt,
        })),
        ...interactionActionRows.map((row) => ({
          id: row.id,
          kind: "issue_thread_interaction" as const,
          sourceType: "issue_thread_interaction" as const,
          severity: "warning" as const,
          actionType: row.kind,
          sourceIssueId: row.sourceIssueId,
          sourceIssueIdentifier: row.sourceIssueIdentifier,
          sourceIssueTitle: row.sourceIssueTitle,
          title: row.title?.trim() || humanizeActionType(row.kind),
          summary: summarizeInteraction(row.kind, row.summary, row.payload),
          reason: "Issue thread interaction requires a board response",
          actionLabel: "Respond in thread",
          href: `/issues/${row.sourceIssueIdentifier ?? row.sourceIssueId}`,
          createdAt: row.createdAt,
          updatedAt: row.createdAt,
        })),
        ...failedRunRows.map((row) => ({
          id: row.id,
          kind: "failed_run" as const,
          sourceType: "failed_run" as const,
          severity: "critical" as const,
          actionType: "operator_repair",
          sourceIssueId: null,
          sourceIssueIdentifier: null,
          sourceIssueTitle: null,
          title: `${row.agentName} run failed`,
          summary: row.error || row.errorCode || "Run failed and needs operator repair",
          reason: "Failed run appears to require operator-facing configuration, credentials, access, runtime setup, or retry",
          actionLabel: "Repair and retry run",
          href: `/agents/${row.agentId}/runs/${row.id}`,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
        ...joinRequestRows.map((row) => ({
          id: row.id,
          kind: "join_request" as const,
          sourceType: "join_request" as const,
          severity: "warning" as const,
          actionType: "access_approval",
          sourceIssueId: null,
          sourceIssueIdentifier: null,
          sourceIssueTitle: null,
          title: `${humanizeActionType(row.requestType)} join request awaiting approval`,
          summary:
            row.requestEmailSnapshot
              ? `${row.requestEmailSnapshot} is requesting access`
              : row.agentName
                ? `${row.agentName} (${row.adapterType ?? "agent"}) is requesting access`
                : "Join request awaiting board approval",
          reason: "Access or join request requires board approval",
          actionLabel: "Review access request",
          href: "/access",
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      ]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, DASHBOARD_BOARD_ACTION_LIMIT);

      return {
        companyId,
        agents: {
          active: agentCounts.active,
          running: agentCounts.running,
          paused: agentCounts.paused,
          error: agentCounts.error,
        },
        tasks: taskCounts,
        costs: {
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(utilization.toFixed(2)),
        },
        pendingApprovals,
        boardActions,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
        runActivity: Array.from(runActivity.values()),
      };
    },
  };
}

export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  failed: number;
  other: number;
  total: number;
}

export interface DashboardBoardAction {
  id: string;
  kind: "approval" | "issue_thread_interaction" | "failed_run" | "join_request";
  sourceType: "approval" | "issue_thread_interaction" | "failed_run" | "join_request";
  severity: "info" | "warning" | "critical";
  actionType: string;
  sourceIssueId?: string | null;
  sourceIssueIdentifier?: string | null;
  sourceIssueTitle?: string | null;
  title: string;
  summary: string;
  reason: string;
  actionLabel: string;
  href: string;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
}

export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  boardActions: DashboardBoardAction[];
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  runActivity: DashboardRunActivityDay[];
}

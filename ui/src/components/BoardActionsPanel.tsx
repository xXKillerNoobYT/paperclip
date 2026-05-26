import type { DashboardBoardAction } from "@paperclipai/shared";
import { AlertTriangle, ClipboardCheck } from "lucide-react";
import { Link } from "@/lib/router";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

function humanizeActionType(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function severityClasses(severity: DashboardBoardAction["severity"]): string {
  if (severity === "critical") return "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-200";
  if (severity === "warning") return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-200";
  return "border-primary/20 bg-primary/10 text-primary";
}

function itemLabel(count: number): string {
  return `${count} item${count === 1 ? "" : "s"}`;
}

export function BoardActionsPanel({ actions = [] }: { actions?: DashboardBoardAction[] }) {
  const urgentCount = actions.filter((action) => action.severity === "critical").length;

  return (
    <section className="rounded-xl border border-border bg-card/80 shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-start gap-2.5">
          <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Needs board action
              </h3>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {itemLabel(actions.length)}
              </span>
              {urgentCount > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-red-500/25 bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-200">
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  {urgentCount} urgent
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Pending approvals, questions, confirmations, blockers, and operator repairs that need a board response.
            </p>
          </div>
        </div>
        <Link to="/inbox" className="text-sm text-primary underline underline-offset-2">
          Open inbox
        </Link>
      </div>
      {actions.length === 0 ? (
        <div className="px-4 py-5">
          <p className="text-sm font-medium text-foreground">No board action needed.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Agents can continue without approvals, answers, or operator repair.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border">
          {actions.slice(0, 10).map((action) => (
            <Link
              key={`${action.kind}:${action.id}`}
              to={action.href}
              aria-label={`${action.actionLabel}: ${action.title}`}
              className="block px-4 py-3 text-inherit no-underline transition-colors hover:bg-accent/50"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide",
                      severityClasses(action.severity),
                    )}>
                      {humanizeActionType(action.actionType)}
                    </span>
                    {action.sourceIssueIdentifier ? (
                      <span className="font-mono text-xs text-muted-foreground">
                        {action.sourceIssueIdentifier}
                      </span>
                    ) : null}
                  </div>
                  <p className="line-clamp-1 text-sm font-medium">
                    {action.sourceIssueTitle ?? action.title}
                  </p>
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {action.summary}
                  </p>
                  <p className="line-clamp-2 text-xs text-muted-foreground">
                    Reason: {action.reason}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground sm:flex-col sm:items-end sm:gap-1">
                  <span>{timeAgo(action.createdAt)}</span>
                  <span className="font-medium text-primary">{action.actionLabel}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

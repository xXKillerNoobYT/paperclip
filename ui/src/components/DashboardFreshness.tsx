import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { AlertTriangle, CheckCircle2, Clock3, RefreshCw } from "lucide-react";
import type { Agent, Issue } from "@paperclipai/shared";
import { Identity } from "./Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

const STALE_AFTER_MS = 5 * 60 * 1000;
const PRIORITY_WEIGHT: Record<Issue["priority"], number> = { critical: 0, high: 1, medium: 2, low: 3 };

type SourceMode = "LIVE" | "DAILY";
type SourceState = "checking" | "fresh" | "stale" | "error";

export interface DashboardSourceDiagnostic {
  id: string;
  label: string;
  mode: SourceMode;
  state: SourceState;
  lastGoodAt: number | null;
  cadence: string;
  nextAttempt: string;
  canRetry: boolean;
  retryLabel: string;
  onRetry: () => void;
}

export interface NowNextItem {
  issue: Issue;
  assigneeName: string | null;
  phaseTag: string;
  trailingLabel: string;
  queueRank?: number;
}

function getTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatTimestamp(value: number | null): string {
  if (!value) return "No last good";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function derivePhaseTag(issue: Issue): string {
  const label = issue.labels?.find((item) => /phase/i.test(item.name))?.name;
  if (label) return label;
  if (issue.status === "in_progress") return "Active";
  if (issue.status === "in_review") return "Review";
  if (issue.status === "blocked") return "Blocked";
  if (issue.status === "todo") return "Ready";
  if (issue.status === "backlog") return "Backlog";
  return issue.status.replace(/_/g, " ");
}

export function buildNowNextItems(issues: Issue[], agents: Agent[] | undefined): { now: NowNextItem[]; next: NowNextItem[] } {
  const agentById = new Map((agents ?? []).map((agent) => [agent.id, agent.name]));
  const toItem = (issue: Issue, index?: number): NowNextItem => ({
    issue,
    assigneeName: issue.assigneeAgentId ? agentById.get(issue.assigneeAgentId) ?? "Assigned agent" : null,
    phaseTag: derivePhaseTag(issue),
    trailingLabel: typeof index === "number" ? `Rank ${index + 1}` : `Last activity ${timeAgo(issue.lastActivityAt ?? issue.updatedAt)}`,
    queueRank: typeof index === "number" ? index + 1 : undefined,
  });

  return {
    now: issues
      .filter((issue) => issue.status === "in_progress")
      .sort((a, b) => getTimestamp(b.lastActivityAt ?? b.updatedAt) - getTimestamp(a.lastActivityAt ?? a.updatedAt))
      .map((issue) => toItem(issue)),
    next: issues
      .filter((issue) => issue.status === "todo" || issue.status === "backlog")
      .sort((a, b) => {
        const priorityDelta = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
        if (priorityDelta !== 0) return priorityDelta;
        const createdDelta = getTimestamp(a.createdAt) - getTimestamp(b.createdAt);
        return createdDelta === 0 ? a.id.localeCompare(b.id) : createdDelta;
      })
      .slice(0, 5)
      .map((issue, index) => toItem(issue, index)),
  };
}

export function sourceState(input: { isLoading: boolean; isFetching: boolean; isError: boolean; dataUpdatedAt: number }): SourceState {
  if (input.isError) return "error";
  if (input.isLoading || (input.isFetching && input.dataUpdatedAt === 0)) return "checking";
  if (input.dataUpdatedAt > 0 && Date.now() - input.dataUpdatedAt > STALE_AFTER_MS) return "stale";
  return "fresh";
}

function DashboardIssueSkeletonRows() {
  return <div className="space-y-2" aria-hidden="true">{[0, 1, 2].map((index) => <div key={index} className="h-[58px] animate-pulse rounded-md border border-border bg-muted/50" />)}</div>;
}

function NowNextRow({ item }: { item: NowNextItem }) {
  const { issue, assigneeName, phaseTag, trailingLabel } = item;
  const identifier = issue.identifier ?? issue.id.slice(0, 8);
  return (
    <li className="min-w-0">
      <Link to={`/issues/${identifier}`} className="block rounded-md border border-border px-3 py-2 text-inherit no-underline transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{identifier}</span>
              <span className="min-w-0 truncate text-sm font-medium">{issue.title}</span>
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {assigneeName ? <Identity name={assigneeName} size="xs" className="max-w-[150px]" /> : <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border text-[10px] font-medium" aria-label="Unassigned">--</span>}
              <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[11px] uppercase tracking-normal text-foreground">{phaseTag}</span>
            </div>
          </div>
          <span className={cn("shrink-0 whitespace-nowrap text-xs", item.queueRank ? "font-medium text-foreground" : "text-muted-foreground")}>{trailingLabel}</span>
        </div>
      </Link>
    </li>
  );
}

export function DashboardNowNextPanel({ now, next, isLoading, isError, hasCachedRows, onRetry }: { now: NowNextItem[]; next: NowNextItem[]; isLoading: boolean; isError: boolean; hasCachedRows: boolean; onRetry: () => void }) {
  const renderColumn = (label: string, items: NowNextItem[], empty: ReactNode) => (
    <section className="min-w-0">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{label}</h3>
      {isLoading ? <DashboardIssueSkeletonRows /> : items.length === 0 ? <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">{empty}</div> : <ul className="space-y-2">{items.map((item) => <NowNextRow key={item.issue.id} item={item} />)}</ul>}
    </section>
  );

  return (
    <div className="space-y-3">
      {isError && <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/25 dark:bg-amber-950/60 dark:text-amber-100"><span>{hasCachedRows ? "GitHub refresh failed. Showing last-good Now & Next rows." : "GitHub refresh failed. No cached Now & Next rows are available."}</span><button type="button" onClick={onRetry} className="inline-flex shrink-0 items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><RefreshCw className="h-3 w-3" />Retry</button></div>}
      <div className="grid gap-4 lg:grid-cols-2">
        {renderColumn("Now", now, "No issues in progress. Pick one from Next ->")}
        {renderColumn("Next", next, <><span>Backlog is empty.</span> <Link to="/issues" className="underline underline-offset-2">Open board</Link></>)}
      </div>
    </div>
  );
}

export function CurrentPhaseCard({ open, done }: { open: number; done: number }) {
  const total = open + done;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return <section className="rounded-md border border-border p-4"><div className="mb-3 flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Current Phase</h3><p className="text-sm text-foreground">Execution progress</p></div><span className="text-sm font-medium">{percent}%</span></div><div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={`Current phase ${percent}% complete`} className="h-2.5 rounded-full bg-muted sm:h-3"><div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} /><span className="sr-only">{percent}% complete</span></div><p className="mt-2 text-xs text-muted-foreground">{done} done · {open} open</p></section>;
}

export function DashboardFreshnessFooter({ diagnostics }: { diagnostics: DashboardSourceDiagnostic[] }) {
  const iconForState = (state: SourceState) => {
    if (state === "error") return <AlertTriangle className="h-3.5 w-3.5 text-destructive" />;
    if (state === "stale") return <Clock3 className="h-3.5 w-3.5 text-amber-600" />;
    if (state === "checking") return <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />;
    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />;
  };
  return <footer className="grid gap-2 border-t border-border pt-3 text-xs md:grid-cols-2 xl:grid-cols-4" aria-label="Dashboard source freshness">{diagnostics.map((source) => <section key={source.id} className="min-w-0 rounded-md border border-border p-3"><div className="flex items-center justify-between gap-2"><div className="flex min-w-0 items-center gap-2">{iconForState(source.state)}<span className="truncate font-medium">{source.label}</span></div><span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px]">{source.mode}</span></div><dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-muted-foreground"><dt>State</dt><dd className={cn("truncate", source.state === "stale" && "text-amber-700 dark:text-amber-300", source.state === "error" && "text-destructive")}>{source.state}</dd><dt>Last good</dt><dd className={cn("truncate", source.state === "stale" && "text-amber-700 dark:text-amber-300")}>{formatTimestamp(source.lastGoodAt)}</dd><dt>Next</dt><dd className="truncate">{source.nextAttempt}</dd></dl><button type="button" onClick={source.onRetry} disabled={!source.canRetry} aria-label={`${source.retryLabel} ${source.label}`} className="mt-2 inline-flex w-full items-center justify-center gap-1 rounded-sm border border-border px-2 py-1 font-medium disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><RefreshCw className="h-3 w-3" />{source.retryLabel}</button><p className="mt-1 truncate text-muted-foreground">{source.cadence}</p></section>)}</footer>;
}

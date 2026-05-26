// @vitest-environment jsdom

import { act } from "react";
import type React from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import type { DashboardBoardAction, Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardActionsPanel } from "../components/BoardActionsPanel";
import {
  CurrentPhaseCard,
  DashboardFreshnessFooter,
  DashboardNowNextPanel,
  type DashboardSourceDiagnostic,
} from "../components/DashboardFreshness";

vi.hoisted(() => {
  const sheet = globalThis.CSSStyleSheet as typeof CSSStyleSheet | undefined;
  if (sheet?.prototype) {
    sheet.prototype.insertRule = function insertRule() {
      return 0;
    };
  }
});

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, to, ...props }: ComponentProps<"a"> & { to?: string }) => (
    <a className={className} href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/", search: "", hash: "" }),
  useNavigate: () => () => {},
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

vi.mock("@codesandbox/sandpack-react", () => ({
  Sandpack: () => null,
  SandpackCodeEditor: () => null,
  SandpackLayout: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SandpackPreview: () => null,
  SandpackProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createBoardAction(overrides: Partial<DashboardBoardAction> = {}): DashboardBoardAction {
  return {
    id: "action-1",
    kind: "failed_run",
    sourceType: "failed_run",
    severity: "critical",
    actionType: "operator_repair",
    sourceIssueId: "issue-1",
    sourceIssueIdentifier: "WEI-123",
    sourceIssueTitle: "Fix adapter credentials",
    title: "Repair failed run",
    summary: "A failed run needs operator repair before the agent can continue.",
    reason: "Credential error requires board action.",
    actionLabel: "Repair",
    href: "/issues/WEI-123",
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: null,
    ...overrides,
  };
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  const now = new Date("2026-05-20T00:00:00.000Z");
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Wire dashboard freshness metadata",
    description: null,
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 2490,
    identifier: "WEI-2490",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    labels: [{ id: "label-1", companyId: "company-1", name: "Phase 2", color: "#000", createdAt: now, updatedAt: now }],
    lastActivityAt: new Date("2026-05-20T00:55:00.000Z"),
    createdAt: now,
    updatedAt: new Date("2026-05-20T00:58:00.000Z"),
    ...overrides,
  };
}

describe("BoardActionsPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T01:00:00.000Z"));
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("renders the needs-board-action triage surface with count, reason, severity, and row affordance", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <BoardActionsPanel
          actions={[
            createBoardAction(),
            createBoardAction({
              id: "action-2",
              kind: "issue_thread_interaction",
              sourceType: "issue_thread_interaction",
              severity: "warning",
              actionType: "ask_user_questions",
              sourceIssueIdentifier: "WEI-124",
              sourceIssueTitle: "Choose onboarding path",
              title: "Answer agent question",
              summary: "An agent needs a board answer to continue.",
              reason: "Explicit question waiting in the issue thread.",
              actionLabel: "Answer",
              href: "/issues/WEI-124",
            }),
          ]}
        />,
      );
    });

    expect(container.textContent).toContain("Needs board action");
    expect(container.textContent).toContain("2 items");
    expect(container.textContent).toContain("1 urgent");
    expect(container.textContent).toContain("Credential error requires board action.");
    expect(container.textContent).toContain("Repair");
    expect(container.textContent).toContain("Answer");

    const firstLink = container.querySelector('a[href="/issues/WEI-123"]');
    expect(firstLink).not.toBeNull();
    expect(firstLink?.getAttribute("aria-label")).toContain("Repair failed run");

    act(() => {
      root.unmount();
    });
  });

  it("renders quiet empty state copy when no action is needed", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<BoardActionsPanel actions={[]} />);
    });

    expect(container.textContent).toContain("No board action needed.");
    expect(container.textContent).toContain("Agents can continue without approvals, answers, or operator repair.");

    act(() => {
      root.unmount();
    });
  });
});

describe("Dashboard freshness and Now & Next panels", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T01:00:00.000Z"));
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("renders Now and Next rows with spec metadata and cached-error retry affordance", () => {
    const root = createRoot(container);
    const retry = vi.fn();

    act(() => {
      root.render(
        <DashboardNowNextPanel
          now={[{
            issue: createIssue(),
            assigneeName: "Frontend Coder",
            phaseTag: "Phase 2",
            trailingLabel: "Last activity 5m ago",
          }]}
          next={[{
            issue: createIssue({
              id: "issue-2",
              identifier: "WEI-2491",
              title: "Queue browser smoke",
              status: "todo",
              assigneeAgentId: null,
            }),
            assigneeName: null,
            phaseTag: "Ready",
            trailingLabel: "Rank 1",
            queueRank: 1,
          }]}
          isLoading={false}
          isError={true}
          hasCachedRows={true}
          onRetry={retry}
        />,
      );
    });

    expect(container.textContent).toContain("Showing last-good Now & Next rows");
    expect(container.querySelector('a[href="/issues/WEI-2490"]')?.textContent).toContain("WEI-2490");
    expect(container.textContent).toContain("Wire dashboard freshness metadata");
    expect(container.textContent).toContain("Frontend Coder");
    expect(container.textContent).toContain("Phase 2");
    expect(container.textContent).toContain("Last activity 5m ago");
    expect(container.textContent).toContain("Rank 1");

    act(() => {
      container.querySelector("button")?.click();
    });
    expect(retry).toHaveBeenCalledOnce();

    act(() => {
      root.unmount();
    });
  });

  it("renders required empty copy and progressbar dimensions/accessibility", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <>
          <DashboardNowNextPanel
            now={[]}
            next={[]}
            isLoading={false}
            isError={false}
            hasCachedRows={false}
            onRetry={() => undefined}
          />
          <CurrentPhaseCard open={3} done={1} />
        </>,
      );
    });

    expect(container.textContent).toContain("No issues in progress. Pick one from Next ->");
    expect(container.textContent).toContain("Backlog is empty.");
    const progress = container.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute("aria-valuenow")).toBe("25");
    expect(progress?.getAttribute("aria-valuemin")).toBe("0");
    expect(progress?.getAttribute("aria-valuemax")).toBe("100");
    expect(progress?.className).toContain("h-2.5");
    expect(progress?.className).toContain("sm:h-3");

    act(() => {
      root.unmount();
    });
  });

  it("renders per-source diagnostics with stale/error state and fetch-only controls", () => {
    const root = createRoot(container);
    const retry = vi.fn();
    const diagnostics: DashboardSourceDiagnostic[] = [
      {
        id: "now-next",
        label: "Now & Next",
        mode: "LIVE",
        state: "stale",
        lastGoodAt: new Date("2026-05-20T00:50:00.000Z").getTime(),
        cadence: "Auto refreshes with issue data",
        nextAttempt: "on window focus",
        canRetry: true,
        retryLabel: "Retry",
        onRetry: retry,
      },
      {
        id: "area-progress",
        label: "Area Progress",
        mode: "DAILY",
        state: "error",
        lastGoodAt: null,
        cadence: "Daily rollup",
        nextAttempt: "next daily rollup",
        canRetry: false,
        retryLabel: "Refresh",
        onRetry: retry,
      },
    ];

    act(() => {
      root.render(<DashboardFreshnessFooter diagnostics={diagnostics} />);
    });

    expect(container.textContent).toContain("Now & Next");
    expect(container.textContent).toContain("LIVE");
    expect(container.textContent).toContain("stale");
    expect(container.textContent).toContain("Area Progress");
    expect(container.textContent).toContain("DAILY");
    expect(container.textContent).toContain("error");

    const buttons = Array.from(container.querySelectorAll("button")) as HTMLButtonElement[];
    const retryButton = buttons.find((button) => button.getAttribute("aria-label") === "Retry Now & Next")!;
    expect(retryButton.disabled).toBe(false);
    expect(buttons.find((button) => button.getAttribute("aria-label") === "Refresh Area Progress")?.disabled).toBe(true);
    act(() => {
      retryButton.click();
    });
    expect(retry).toHaveBeenCalledOnce();

    act(() => {
      root.unmount();
    });
  });
});

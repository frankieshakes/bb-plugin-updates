// bb-plugin-plugin-updates — frontend. A count on the Plugin Updates nav rail
// icon shows how many plugins have updates; the page applies them. Toasts
// announce newly found versions.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { OutOfRangeResult, UpdateJob, rpcContract } from "./server";
import type { OutOfRangeItem, Report } from "./src/report";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const PANEL_PATH = "updates";

type Snapshot = { report: Report; checkedAt: number } | null;

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The last check's report, refetched whenever the server says it changed. */
function useUpdates() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(undefined);
  const refetch = useCallback(() => {
    rpc.call("report").then(setSnapshot, (cause) => toast.error(errorText(cause)));
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("report-changed", refetch);
  // Signals aren't replayed after a reconnect; reconcile instead.
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (wasConnected.current) refetch();
    wasConnected.current = true;
  }, [connection, refetch]);
  return { rpc, snapshot, setSnapshot, refetch };
}

// ── Nav rail count + new-update toasts ─────────────────────────────────────

const PANEL_TITLE = "Plugin Updates";
const BUBBLE_ATTR = "data-plugin-updates-count";

/**
 * bb doesn't render `experimental_sidebarAccessory` on the icon-only nav rail
 * yet, so decorate our rail entry directly. It's found by bb's
 * `data-nav-rail-item` wrapper and the button's label; if bb changes that
 * markup the bubble just doesn't show.
 */
function findRailItem(): HTMLElement | null {
  for (const item of Array.from(document.querySelectorAll<HTMLElement>("[data-nav-rail-item]"))) {
    const id = item.getAttribute("data-nav-rail-item") ?? "";
    const label = item.querySelector("button")?.getAttribute("aria-label") ?? "";
    if (id.includes("plugin-updates") || label.startsWith(PANEL_TITLE)) return item;
  }
  return null;
}

function paintBubble(count: number) {
  const item = findRailItem();
  const existing = document.querySelector<HTMLElement>(`[${BUBBLE_ATTR}]`);
  if (item === null || count === 0) {
    existing?.remove();
    return;
  }
  const bubble = existing ?? document.createElement("span");
  if (bubble.parentElement !== item) {
    if (getComputedStyle(item).position === "static") item.style.position = "relative";
    bubble.setAttribute(BUBBLE_ATTR, "");
    bubble.setAttribute("aria-hidden", "true");
    bubble.className =
      "pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground";
    item.appendChild(bubble);
  }
  const text = count > 9 ? "9+" : String(count);
  if (bubble.textContent !== text) bubble.textContent = text;
}

/** Keeps the bubble on the rail entry, re-attaching whenever bb re-renders the rail. */
function useRailBubble(count: number) {
  useEffect(() => {
    paintBubble(count);
    const observer = new MutationObserver(() => paintBubble(count));
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      document.querySelector(`[${BUBBLE_ATTR}]`)?.remove();
    };
  }, [count]);
}

/** Headless: owns the rail bubble and the toasts for every app window. */
function UpdatesOverlay() {
  const { snapshot } = useUpdates();
  const navigate = useBbNavigate();
  const open = useCallback(() => navigate.toPluginPanel(PANEL_PATH), [navigate]);
  useRailBubble(snapshot?.report.badgeCount ?? 0);
  useRealtime("new-updates", (payload) => {
    const updates = (payload as { updates?: Array<{ id: string }> } | null)?.updates ?? [];
    if (updates.length === 0) return;
    const names = [...new Set(updates.map(({ id }) => id))];
    toast(
      names.length === 1 ? `Update available for ${names[0]}` : `${names.length} plugins have updates`,
      { action: { label: "View", onClick: open } },
    );
  });
  return null;
}

/** For bb's native rail accessory slot, once a host surface renders it. */
function RailAccessory() {
  const { snapshot } = useUpdates();
  const count = snapshot?.report.badgeCount ?? 0;
  return count === 0 ? null : <span className="text-xs tabular-nums">{count}</span>;
}

// ── Page ───────────────────────────────────────────────────────────────────

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card px-4">
        {children}
      </ul>
    </section>
  );
}

function Collapsed({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <details className="group">
      <summary className="cursor-pointer select-none text-sm text-muted-foreground hover:text-foreground">
        {title} ({count})
      </summary>
      <ul className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card px-4">
        {children}
      </ul>
    </details>
  );
}

function Row({ id, children, actions }: { id: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <li className="flex items-center gap-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{id}</div>
        {children === undefined ? null : (
          <div className="truncate text-xs text-muted-foreground">{children}</div>
        )}
      </div>
      {actions === undefined ? null : <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </li>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
      {children}
    </a>
  );
}

function CopyableCommand({ command }: { command: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted p-2">
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-xs">{command}</code>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label="Copy command"
        onClick={() => {
          navigator.clipboard.writeText(command).then(
            () => toast.success("Copied"),
            (cause) => toast.error(errorText(cause)),
          );
        }}
      >
        <Icon name="Copy" className="size-4" />
      </Button>
    </div>
  );
}

const relativeTime = (at: number) => {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : new Date(at).toLocaleDateString();
};

/** Out-of-range updates reinstall the plugin, so they're confirmed one by one. */
function OutOfRangeDialog({
  item,
  onClose,
  onDone,
}: {
  item: OutOfRangeItem | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OutOfRangeResult | null>(null);
  useEffect(() => {
    setResult(null);
    setRunning(false);
  }, [item]);
  if (item === null) return null;

  const run = async () => {
    setRunning(true);
    try {
      const outcome = await rpc.call("update_out_of_range", { id: item.id });
      if (outcome.kind === "updated") {
        toast.success(`Updated ${item.id} to ${outcome.to}`);
        onDone();
        onClose();
        return;
      }
      if (outcome.kind === "rolled-back") {
        toast.error(`Couldn't update ${item.id}; it's back on ${item.from}. ${outcome.error}`);
        onDone();
        onClose();
        return;
      }
      setResult(outcome);
      onDone();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open || running ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Update {item.id} {item.from} → {item.to}?
          </DialogTitle>
          <DialogDescription>
            {item.to} is outside the range {item.id} was installed with, so bb can't update it in
            place. This removes the plugin and installs the new release. Settings are restored;
            its storage and schedules may reset. If the install fails, the old version is
            reinstalled.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          <ExternalLink href={item.compareUrl}>See what changed</ExternalLink>
        </p>
        {result?.kind === "manual" ? (
          <div className="space-y-2 text-sm">
            <p>
              {result.reason === "self"
                ? "This plugin can't remove itself. Run this in a terminal instead:"
                : `${item.id} has secret settings a reinstall would lose. Run this in a terminal, then re-enter them:`}
            </p>
            <CopyableCommand command={result.command} />
          </div>
        ) : null}
        {result?.kind === "failed" ? (
          <div className="space-y-2 text-sm">
            <p className="text-destructive">
              The update and the rollback both failed, so {item.id} isn't installed. {result.error}
            </p>
            <p>Reinstall it with:</p>
            <CopyableCommand command={result.command} />
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={running}>
            {result === null ? "Cancel" : "Close"}
          </Button>
          {result === null ? (
            <Button onClick={run} disabled={running}>
              {running ? "Updating…" : `Update to ${item.to}`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const isActive = (job: UpdateJob) => job.state === "queued" || job.state === "running";

/** bb's background update jobs: polled while any is active, re-check when one ends. */
function useUpdateJobs(onSettled: () => void) {
  const rpc = useRpc<typeof rpcContract>();
  const [jobs, setJobs] = useState<UpdateJob[]>([]);
  const poll = useCallback(async () => {
    const { jobs: next } = await rpc.call("jobs");
    setJobs((previous) => {
      for (const job of next) {
        const before = previous.find((p) => p.id === job.id);
        if (before === undefined || !isActive(before) || isActive(job)) continue;
        if (job.state === "completed") {
          if (job.result.outcome === "rolled-back") {
            toast.error(`${job.pluginId} update rolled back. ${job.result.detail ?? ""}`);
          } else toast.success(`Updated ${job.pluginId}`);
        } else if (job.state === "failed") toast.error(`${job.pluginId}: ${job.error}`);
        onSettled();
      }
      return next;
    });
  }, [rpc, onSettled]);
  // Reconcile on load: jobs outlive the page (not a server restart).
  useEffect(() => {
    poll().catch(() => undefined);
  }, [poll]);
  const anyActive = jobs.some(isActive);
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => poll().catch(() => undefined), 1500);
    return () => clearInterval(timer);
  }, [anyActive, poll]);
  const track = (started: UpdateJob[]) =>
    setJobs((previous) => [...previous.filter((p) => !started.some((s) => s.id === p.id)), ...started]);
  const activeFor = (id: string) => jobs.some((job) => job.pluginId === id && isActive(job));
  return { track, activeFor };
}

function UpdatesPage() {
  const { rpc, snapshot, setSnapshot } = useUpdates();
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState<OutOfRangeItem | null>(null);

  const checkNow = useCallback(async () => {
    setChecking(true);
    try {
      setSnapshot(await rpc.call("check"));
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setChecking(false);
    }
  }, [rpc, setSnapshot]);
  const jobs = useUpdateJobs(checkNow);

  const call = (promise: Promise<Snapshot>) =>
    promise.then(setSnapshot, (cause) => toast.error(errorText(cause)));
  const ignore = (id: string, version: string) => call(rpc.call("ignore", { id, version }));
  const unignore = (id: string, version: string) => call(rpc.call("unignore", { id, version }));
  const update = (id: string) =>
    rpc.call("update", { id }).then(({ job }) => jobs.track([job]), (cause) => toast.error(errorText(cause)));
  const updateAll = () =>
    rpc.call("update_all").then(({ jobs: started }) => jobs.track(started), (cause) => toast.error(errorText(cause)));

  const report = snapshot?.report;
  const failures = new Map(report?.releaseCheckFailures.map((f) => [f.id, f.error]) ?? []);
  const ignoreButton = (id: string, version: string) => (
    <Button variant="ghost" size="sm" onClick={() => ignore(id, version)}>
      Ignore
    </Button>
  );

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-6 px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>
            {snapshot === undefined
              ? "Loading…"
              : snapshot === null
                ? "Not checked yet."
                : `Last checked ${relativeTime(snapshot.checkedAt)}.`}
          </span>
          <Button variant="outline" size="sm" onClick={checkNow} disabled={checking}>
            <Icon name="RotateCcw" className={cn("size-4", checking && "animate-spin")} />
            {checking ? "Checking…" : "Check now"}
          </Button>
        </div>

        {report === undefined ? null : (
          <>
            {report.badgeCount === 0 ? (
              <div
                role="status"
                className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
              >
                Every plugin is up to date.
              </div>
            ) : null}

            {report.compatible.length === 0 ? null : (
              <Section
                title="Compatible updates"
                action={
                  report.compatible.length > 1 ? (
                    <Button size="sm" onClick={updateAll}>
                      Update all
                    </Button>
                  ) : undefined
                }
              >
                {report.compatible.map((item) => (
                  <Row
                    key={item.id}
                    id={item.id}
                    actions={
                      <>
                        {ignoreButton(item.id, item.version)}
                        <Button size="sm" onClick={() => update(item.id)} disabled={jobs.activeFor(item.id)}>
                          {jobs.activeFor(item.id) ? "Updating…" : "Update"}
                        </Button>
                      </>
                    }
                  >
                    {item.from} → {item.to}
                  </Row>
                ))}
              </Section>
            )}

            {report.outOfRange.length === 0 ? null : (
              <Section title="Newer releases outside the installed range">
                {report.outOfRange.map((item) => (
                  <Row
                    key={item.id}
                    id={item.id}
                    actions={
                      <>
                        {ignoreButton(item.id, item.version)}
                        <Button size="sm" variant="outline" onClick={() => setConfirming(item)}>
                          Update…
                        </Button>
                      </>
                    }
                  >
                    {item.from} → {item.to} ·{" "}
                    <ExternalLink href={item.compareUrl}>changes</ExternalLink>
                  </Row>
                ))}
              </Section>
            )}

            {report.blocked.length === 0 ? null : (
              <Section title="Blocked by engine ranges">
                {report.blocked.map((item) => (
                  <Row key={item.id} id={item.id}>
                    {item.version}: {item.reasons.join("; ")}
                  </Row>
                ))}
              </Section>
            )}

            {failures.size === 0 ? null : (
              <Section title="Couldn't check for newer releases">
                {[...failures].map(([id, error]) => (
                  <Row key={id} id={id}>
                    <span title={error}>{error}</span>
                  </Row>
                ))}
              </Section>
            )}

            <div className="space-y-3">
              <Collapsed title="Ignored" count={report.ignored.length}>
                {report.ignored.map((item) => (
                  <Row
                    key={`${item.id}@${item.version}`}
                    id={item.id}
                    actions={
                      <Button variant="ghost" size="sm" onClick={() => unignore(item.id, item.version)}>
                        Un-ignore
                      </Button>
                    }
                  >
                    {item.kind === "out-of-range" ? `${item.from} → ${item.to}` : item.to}
                  </Row>
                ))}
              </Collapsed>
              <Collapsed title="Up to date" count={report.upToDate.length}>
                {report.upToDate.map((item) => (
                  <Row key={item.id} id={item.id}>
                    {item.installed}
                  </Row>
                ))}
              </Collapsed>
              <Collapsed title="Pinned, built in, or unavailable" count={report.other.length}>
                {report.other.map((item) => (
                  <Row key={item.id} id={item.id}>
                    {item.outcome} · {item.installed}
                    {item.detail === undefined ? "" : ` · ${item.detail}`}
                  </Row>
                ))}
              </Collapsed>
            </div>
          </>
        )}
      </div>
      <OutOfRangeDialog item={confirming} onClose={() => setConfirming(null)} onDone={checkNow} />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "plugin-updates",
    title: PANEL_TITLE,
    icon: "plugin-updates/update",
    path: PANEL_PATH,
    component: UpdatesPage,
    experimental_sidebarAccessory: RailAccessory,
  });
  app.slots.experimental_appOverlay({ id: "rail-count-and-toasts", component: UpdatesOverlay });
});

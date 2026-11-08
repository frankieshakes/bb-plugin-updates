import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listRemoteTags, readPackageJsonAt } from "../src/git";
import plugin from "../server";

vi.mock("../src/git", () => ({ listRemoteTags: vi.fn(), readPackageJsonAt: vi.fn() }));

interface FakePlugin {
  source: string;
  enabled?: boolean;
  version: string;
  detail?: { range?: string; resolvedTag?: string; tagPrefix?: string; subdirectory?: string };
  check: { outcome: string; candidate?: { version: string; display: string } };
  settings?: {
    schema: Record<string, { type: string; label: string; secret?: true }>;
    values: Record<string, unknown>;
  };
}

/**
 * A tiny stand-in for bb's plugin registry that sdk.plugins operates on.
 * Like bb, removing a plugin deletes its settings; `failInstall` makes
 * installs of matching sources throw.
 */
function fakeRegistry(
  initial: Record<string, FakePlugin>,
  failInstall: (source: string) => boolean = () => false,
) {
  const installed = new Map(Object.entries(initial));
  const removed = new Map<string, FakePlugin>();
  const startedUpdates: string[] = [];
  const finishedUpdates = new Set<string>();
  const display = (p: FakePlugin) => `${p.source} (${p.version})`;
  const checkCalls: Array<string | undefined> = [];
  let checkFailure = (_pluginId?: string): Error | undefined => undefined;
  return {
    installed,
    startedUpdates,
    /** Each checkUpdates call's pluginId (undefined: the bulk check). */
    checkCalls,
    /** Makes checkUpdates throw what `fail` returns for a call's pluginId. */
    failCheck: (fail: typeof checkFailure) => (checkFailure = fail),
    /** Jobs run until finished here. */
    finishUpdate: (pluginId: string) => finishedUpdates.add(pluginId),
    plugins: {
      experimental_updateJobs: {
        list: async () =>
          startedUpdates.map((pluginId) => ({
            id: `job-${pluginId}`,
            pluginId,
            displayName: pluginId,
            ...(finishedUpdates.has(pluginId)
              ? { state: "completed", result: { outcome: "updated" } }
              : { state: "running", phase: "activating" }),
          })),
      },
      experimental_startUpdate: async ({ pluginId }: { pluginId: string }) => {
        startedUpdates.push(pluginId);
        return { id: `job-${pluginId}`, pluginId, displayName: pluginId, state: "queued" };
      },
      list: async () => ({
        plugins: [...installed].map(([id, p]) => ({
          id,
          source: p.source,
          version: p.version,
          enabled: p.enabled ?? true,
        })),
      }),
      checkUpdates: async (args?: { pluginId?: string }) => {
        checkCalls.push(args?.pluginId);
        const failure = checkFailure(args?.pluginId);
        if (failure !== undefined) throw failure;
        return [...installed].filter(([id]) => args?.pluginId === undefined || id === args.pluginId).map(([id, p]) => ({
          id,
          installed: { version: p.version, display: display(p) },
          ...p.check,
        }));
      },
      getSource: async ({ pluginId }: { pluginId: string }) => {
        const p = installed.get(pluginId)!;
        return { requested: p.source, resolved: display(p), engines: {}, history: [], ...p.detail };
      },
      remove: async ({ pluginId }: { pluginId: string }) => {
        removed.set(pluginId, installed.get(pluginId)!);
        installed.delete(pluginId);
        return { ok: true };
      },
      install: async ({ source }: { source: string }) => {
        if (failInstall(source)) throw new Error(`build failed for ${source}`);
        const [id, previous] = [...removed].find(([, p]) => sameRepo(p.source, source))!;
        removed.delete(id);
        const settings = previous.settings && { ...previous.settings, values: {} };
        installed.set(id, { ...previous, source, settings });
        return { id };
      },
      updateSettings: async ({ pluginId, values }: { pluginId: string; values: Record<string, unknown> }) => {
        const p = installed.get(pluginId)!;
        p.settings = { ...p.settings!, values: { ...p.settings!.values, ...values } };
        return { ok: true, ...p.settings };
      },
      getSettings: async ({ pluginId }: { pluginId: string }) => ({
        ok: true,
        ...(installed.get(pluginId)!.settings ?? { schema: {}, values: {} }),
      }),
    },
  };
}

const sha = (n: number) => String(n).repeat(40);
const sameRepo = (a: string, b: string) => a.split("@")[0] === b.split("@")[0];

const homepage: FakePlugin = {
  source: "git:https://github.com/y/bb-homepage.git@semver:^0.2.0",
  version: "0.2.5",
  detail: { range: "^0.2.0", resolvedTag: "v0.2.5" },
  check: {
    outcome: "update-available",
    candidate: { version: "dbcb6f5", display: "bb-homepage@v0.2.7" },
  },
};

const agentBoard: FakePlugin = {
  source: "git:https://github.com/a/bb-plugin-agent-board.git@semver:^0.7.0",
  version: "0.7.0",
  detail: { range: "^0.7.0", resolvedTag: "v0.7.0" },
  check: { outcome: "current" },
};

const agentBoardTags = `${sha(1)}\trefs/tags/v0.7.0\n${sha(2)}\trefs/tags/v0.9.2`;

type RpcReport = {
  compatible: Array<{ id: string }>;
  outOfRange: Array<{ id: string; to: string }>;
  ignored: Array<{ id: string; version: string }>;
  badgeCount: number;
};

/** bb's version, as `bb.sdk.system.version()` reports it. */
const runningBb = (currentVersion: string) => ({
  version: async () => ({
    currentVersion,
    currentCommit: null,
    installKind: "desktop",
    isDevelopment: false,
    latestVersion: null,
    source: "npm",
    updateAvailable: false,
    upgradeCommand: "",
  }),
});

async function load(
  registry: ReturnType<typeof fakeRegistry>,
  settings = {},
  { jobWaitTimeoutMs = 60_000, bbVersion = undefined as string | undefined } = {},
) {
  const host = createFakePluginHost({
    pluginId: "plugin-updates",
    settings,
    sdk: {
      plugins: registry.plugins,
      ...(bbVersion === undefined ? {} : { system: runningBb(bbVersion) }),
    },
  });
  await plugin(host.bb, { jobPollMs: 10, jobWaitTimeoutMs });
  const rpc = async <T>(method: string, input: unknown = null) =>
    (await host.harness.behavior.callRpc(method, input)) as T;
  return { ...host, rpc };
}

type Rpc = Awaited<ReturnType<typeof load>>["rpc"];
type QueueEntry = { run: number; id: string; state: string; result?: unknown };

const queue = async (rpc: Rpc) =>
  (await rpc<{ entries: QueueEntry[] }>("out_of_range_queue")).entries;

/** Queues an out-of-range update over RPC and waits for its outcome. */
async function updateOutOfRange(rpc: Rpc, id: string) {
  const request = await rpc<{ kind: string; entry: QueueEntry }>("update_out_of_range", { id });
  if (request.kind !== "entry") return request;
  return vi.waitFor(async () => {
    const entry = (await queue(rpc)).find((e) => e.run === request.entry.run)!;
    expect(entry.state).toBe("done");
    return entry.result;
  });
}

/** A plugin like agent-board, in its own repo, with a newer release outside its range. */
const board = (name: string): FakePlugin => ({
  ...agentBoard,
  source: `git:https://github.com/a/${name}.git@semver:^0.7.0`,
});

/** Holds every install until `release` lets the oldest one through. */
function holdInstalls(registry: ReturnType<typeof fakeRegistry>) {
  const install = registry.plugins.install;
  const waiting: Array<() => void> = [];
  const sources: string[] = [];
  registry.plugins.install = async (args: { source: string }) => {
    sources.push(args.source);
    await new Promise<void>((resolve) => waiting.push(resolve));
    return install(args);
  };
  return {
    sources,
    release: () =>
      vi.waitFor(() => {
        expect(waiting.length).toBeGreaterThan(0);
        waiting.shift()!();
      }),
  };
}

/** A plugin with both a compatible update and a newer release outside its range. */
const both = (name: string): FakePlugin => ({ ...board(name), check: homepage.check });

const deferredSignals = (harness: Awaited<ReturnType<typeof load>>["harness"]) =>
  harness.inspection.realtimeSignals
    .filter((signal) => signal.channel === "deferred-update")
    .map((signal) => signal.payload);

const states = async (rpc: Rpc) =>
  Object.fromEntries((await queue(rpc)).map((e) => [e.id, e.state]));

const agentBoardWithSettings: FakePlugin = {
  ...agentBoard,
  settings: {
    schema: { theme: { type: "string", label: "Theme" } },
    values: { theme: "dark" },
  },
};

describe("plugin-updates backend", () => {
  beforeEach(() => {
    vi.mocked(listRemoteTags).mockReset();
    vi.mocked(readPackageJsonAt).mockReset();
    vi.mocked(readPackageJsonAt).mockResolvedValue("{}");
  });

  it("check reports compatible updates from bb and newer releases from git", async () => {
    const registry = fakeRegistry({
      homepage: {
        source: "git:https://github.com/y/bb-homepage.git@semver:^0.2.0",
        version: "0.2.5",
        detail: { range: "^0.2.0", resolvedTag: "v0.2.5" },
        check: {
          outcome: "update-available",
          candidate: { version: "dbcb6f5", display: "bb-homepage@v0.2.7" },
        },
      },
      "agent-board": {
        source: "git:https://github.com/a/bb-plugin-agent-board.git@semver:^0.7.0",
        version: "0.7.0",
        detail: { range: "^0.7.0", resolvedTag: "v0.7.0" },
        check: { outcome: "current" },
      },
      tasks: { source: "builtin:tasks", version: "0.1.0", check: { outcome: "pinned" } },
    });
    vi.mocked(listRemoteTags).mockImplementation(async (url) =>
      url.includes("agent-board")
        ? `${sha(1)}\trefs/tags/v0.7.0\n${sha(2)}\trefs/tags/v0.9.2`
        : `${sha(3)}\trefs/tags/v0.2.7`,
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "plugin-updates",
      sdk: { plugins: registry.plugins },
    });
    await plugin(bb);

    const { report } = (await harness.behavior.callRpc("check", null)) as {
      report: { compatible: Array<{ id: string }>; outOfRange: Array<{ id: string; to: string }>; badgeCount: number };
    };

    expect(report.compatible.map(({ id }) => id)).toEqual(["homepage"]);
    expect(report.outOfRange).toMatchObject([{ id: "agent-board", to: "0.9.2" }]);
    expect(report.badgeCount).toBe(2);
    expect(vi.mocked(listRemoteTags).mock.calls.map(([url]) => url).sort()).toEqual([
      "https://github.com/a/bb-plugin-agent-board.git",
      "https://github.com/y/bb-homepage.git",
    ]);
  });

  it("ignoring a version takes it off the badge until it is un-ignored", async () => {
    const registry = fakeRegistry({ homepage, "agent-board": agentBoard });
    vi.mocked(listRemoteTags).mockImplementation(async (url) =>
      url.includes("agent-board") ? agentBoardTags : "",
    );
    const { rpc } = await load(registry);
    await rpc("check");

    await rpc("ignore", { id: "agent-board", version: "0.9.2" });
    const ignored = await rpc<{ report: RpcReport }>("report");
    expect(ignored.report.badgeCount).toBe(1);
    expect(ignored.report.ignored).toMatchObject([{ id: "agent-board", version: "0.9.2" }]);

    await rpc("unignore", { id: "agent-board", version: "0.9.2" });
    const restored = await rpc<{ report: RpcReport }>("report");
    expect(restored.report.badgeCount).toBe(2);
    expect(listRemoteTags).toHaveBeenCalledTimes(2);
  });

  it("announces newly found versions once, for the toast", async () => {
    const registry = fakeRegistry({ homepage, "agent-board": agentBoard });
    vi.mocked(listRemoteTags).mockImplementation(async (url) =>
      url.includes("agent-board") ? agentBoardTags : "",
    );
    const { rpc, harness } = await load(registry);

    await rpc("check");
    await rpc("check");

    const announced = harness.inspection.realtimeSignals.filter(
      (signal) => signal.channel === "new-updates",
    );
    expect(announced).toHaveLength(1);
    expect(announced[0]!.payload).toEqual({
      updates: [
        { id: "homepage", version: "dbcb6f5" },
        { id: "agent-board", version: "0.9.2" },
      ],
    });
  });

  it("stays quiet when toasts are turned off", async () => {
    const registry = fakeRegistry({ homepage });
    vi.mocked(listRemoteTags).mockResolvedValue("");
    const { rpc, harness } = await load(registry, { toastOnNewUpdate: false });

    await rpc("check");

    expect(
      harness.inspection.realtimeSignals.filter((signal) => signal.channel === "new-updates"),
    ).toEqual([]);
  });

  it("broadcasts the badge count whenever the report changes", async () => {
    const registry = fakeRegistry({ homepage });
    vi.mocked(listRemoteTags).mockResolvedValue("");
    const { rpc, harness } = await load(registry);

    await rpc("check");
    await rpc("ignore", { id: "homepage", version: "dbcb6f5" });

    expect(
      harness.inspection.realtimeSignals
        .filter((signal) => signal.channel === "report-changed")
        .map((signal) => signal.payload),
    ).toEqual([{ badgeCount: 1 }, { badgeCount: 0 }]);
  });

  it("update all starts bb jobs for compatible updates only, skipping ignored ones", async () => {
    const registry = fakeRegistry({
      homepage,
      "agent-board": agentBoard,
      chat: { ...homepage, check: { ...homepage.check, candidate: { version: "c0ffee1", display: "chat@v0.2" } } },
    });
    vi.mocked(listRemoteTags).mockImplementation(async (url) =>
      url.includes("agent-board") ? agentBoardTags : "",
    );
    const { rpc } = await load(registry);
    await rpc("check");
    await rpc("ignore", { id: "chat", version: "c0ffee1" });

    const { jobs } = await rpc<{ jobs: Array<{ pluginId: string; state: string }> }>("update_all");

    expect(registry.startedUpdates).toEqual(["homepage"]);
    expect(jobs).toMatchObject([{ pluginId: "homepage", state: "queued" }]);
  });

  it("a single compatible update starts a job the page can follow", async () => {
    const registry = fakeRegistry({ homepage });
    vi.mocked(listRemoteTags).mockResolvedValue("");
    const { rpc } = await load(registry);
    await rpc("check");

    const started = await rpc<{ kind: string; job: { id: string } }>("update", { id: "homepage" });
    const { jobs } = await rpc<{ jobs: Array<{ id: string; state: string }> }>("jobs");

    expect(started).toMatchObject({ kind: "job", job: { id: "job-homepage" } });
    expect(jobs).toMatchObject([{ id: "job-homepage", state: "running" }]);
  });

  it("moves a plugin to a newer release outside its range, keeping its settings", async () => {
    const registry = fakeRegistry({
      "agent-board": {
        ...agentBoard,
        settings: {
          schema: { theme: { type: "string", label: "Theme" } },
          values: { theme: "dark" },
        },
      },
    });
    vi.mocked(listRemoteTags).mockResolvedValue(agentBoardTags);
    const { rpc } = await load(registry);
    await rpc("check");

    const result = await updateOutOfRange(rpc, "agent-board");

    expect(result).toEqual({ kind: "updated", from: "0.7.0", to: "0.9.2" });
    expect(registry.installed.get("agent-board")).toMatchObject({
      source: "git:https://github.com/a/bb-plugin-agent-board.git@semver:^0.9.2",
      settings: { values: { theme: "dark" } },
    });
  });

  it("rolls back to the old source when the new release fails to install", async () => {
    const registry = fakeRegistry(
      { "agent-board": agentBoardWithSettings },
      (source) => source.endsWith("^0.9.2"),
    );
    vi.mocked(listRemoteTags).mockResolvedValue(agentBoardTags);
    const { rpc } = await load(registry);
    await rpc("check");

    const result = await updateOutOfRange(rpc, "agent-board");

    expect(result).toEqual({
      kind: "rolled-back",
      error: "build failed for git:https://github.com/a/bb-plugin-agent-board.git@semver:^0.9.2",
    });
    expect(registry.installed.get("agent-board")).toMatchObject({
      source: agentBoard.source,
      settings: { values: { theme: "dark" } },
    });
  });

  it("hands back a reinstall command when the rollback fails too", async () => {
    const registry = fakeRegistry({ "agent-board": agentBoardWithSettings }, () => true);
    vi.mocked(listRemoteTags).mockResolvedValue(agentBoardTags);
    const { rpc } = await load(registry);
    await rpc("check");

    const result = await updateOutOfRange(rpc, "agent-board");

    expect(result).toEqual({
      kind: "failed",
      error: `build failed for ${agentBoard.source}`,
      command: `bb plugin install '${agentBoard.source}'`,
    });
    expect(registry.installed.has("agent-board")).toBe(false);
  });

  it("leaves a plugin with secret settings alone and returns the manual steps", async () => {
    const registry = fakeRegistry({
      "agent-board": {
        ...agentBoard,
        detail: { ...agentBoard.detail, subdirectory: "plugins/board" },
        settings: {
          schema: { apiKey: { type: "string", label: "API key", secret: true } },
          values: {},
        },
      },
    });
    vi.mocked(listRemoteTags).mockResolvedValue(agentBoardTags);
    const { rpc } = await load(registry);
    await rpc("check");

    const result = await updateOutOfRange(rpc, "agent-board");

    expect(result).toEqual({
      kind: "manual",
      reason: "secret-settings",
      command:
        "bb plugin remove agent-board && bb plugin install " +
        "'git:https://github.com/a/bb-plugin-agent-board.git@semver:^0.9.2' --subdirectory 'plugins/board'",
    });
    expect(registry.installed.get("agent-board")?.source).toBe(agentBoard.source);
  });

  it("will not remove itself to update; returns the manual steps instead", async () => {
    const registry = fakeRegistry({
      "plugin-updates": {
        source: "git:https://github.com/f/bb-plugin-updates.git@semver:^0.1.0",
        version: "0.1.0",
        detail: { range: "^0.1.0", resolvedTag: "v0.1.0" },
        check: { outcome: "current" },
      },
    });
    vi.mocked(listRemoteTags).mockResolvedValue(`${sha(1)}\trefs/tags/v0.2.0`);
    const { rpc } = await load(registry);
    await rpc("check");

    const result = await updateOutOfRange(rpc, "plugin-updates");

    expect(result).toMatchObject({ kind: "manual", reason: "self" });
    expect(registry.installed.has("plugin-updates")).toBe(true);
  });

  it("moves a plugin with no settings without touching settings", async () => {
    const registry = fakeRegistry({ "agent-board": agentBoard });
    vi.mocked(listRemoteTags).mockResolvedValue(agentBoardTags);
    const { rpc } = await load(registry);
    await rpc("check");

    const result = await updateOutOfRange(rpc, "agent-board");

    expect(result).toEqual({ kind: "updated", from: "0.7.0", to: "0.9.2" });
  });

  it.each([
    [undefined, "0 */6 * * *"],
    ["1h", "0 * * * *"],
    ["24h", "0 9 * * *"],
  ])("checks on a schedule (interval %s → %s)", async (interval, cron) => {
    const registry = fakeRegistry({ homepage });
    vi.mocked(listRemoteTags).mockResolvedValue("");
    const { rpc, harness } = await load(
      registry,
      interval === undefined ? {} : { checkInterval: interval },
    );

    expect(harness.inspection.registrations.schedules).toMatchObject([{ name: "check", cron }]);
    await harness.behavior.runSchedule("check");
    expect(await rpc<{ report: RpcReport }>("report")).toMatchObject({
      report: { badgeCount: 1 },
    });
  });

  it("does not schedule checks when the interval is off", async () => {
    const { harness } = await load(fakeRegistry({}), { checkInterval: "off" });

    expect(harness.inspection.registrations.schedules).toEqual([]);
  });

  it("checks once when the plugin loads", async () => {
    vi.mocked(listRemoteTags).mockResolvedValue("");
    const { rpc, harness } = await load(fakeRegistry({ homepage }));

    const service = harness.behavior.runService("check-on-load");
    await vi.waitFor(async () =>
      expect(await rpc<{ report: RpcReport } | null>("report")).not.toBeNull(),
    );
    service.controller.abort();
    await service.done;
  });

  it("flags disabled plugins and leaves them out of the badge and Update all", async () => {
    const registry = fakeRegistry({
      homepage: { ...homepage, enabled: false },
      chat: { ...homepage, check: { ...homepage.check, candidate: { version: "c0ffee1", display: "chat@v0.2" } } },
    });
    vi.mocked(listRemoteTags).mockResolvedValue("");
    const { rpc } = await load(registry);
    await rpc("check");

    const { report } = await rpc<{ report: RpcReport & { compatible: Array<{ id: string; disabled?: true }> } }>("report");
    await rpc("update_all");

    expect(report.compatible).toEqual([
      expect.objectContaining({ id: "homepage", disabled: true }),
      expect.not.objectContaining({ disabled: true }),
    ]);
    expect(report.badgeCount).toBe(1);
    expect(registry.startedUpdates).toEqual(["chat"]);
  });

  describe("out-of-range queue", () => {
    it("runs confirmed updates one at a time, in order", async () => {
      const registry = fakeRegistry({ a: board("a"), b: board("b"), c: board("c") });
      vi.mocked(listRemoteTags).mockResolvedValue(agentBoardTags);
      const installs = holdInstalls(registry);
      const { rpc, harness } = await load(registry);
      await rpc("check");

      for (const id of ["a", "b", "c"]) await rpc("update_out_of_range", { id });
      expect(await states(rpc)).toEqual({ a: "running", b: "queued", c: "queued" });

      await installs.release();
      await vi.waitFor(async () =>
        expect(await states(rpc)).toEqual({ a: "done", b: "running", c: "queued" }),
      );
      await installs.release();
      await installs.release();
      await vi.waitFor(async () =>
        expect(await states(rpc)).toEqual({ a: "done", b: "done", c: "done" }),
      );

      expect(installs.sources.map((source) => source.split("/")[4])).toEqual([
        "a.git@semver:^0.9.2",
        "b.git@semver:^0.9.2",
        "c.git@semver:^0.9.2",
      ]);
      expect((await queue(rpc)).map((e) => e.result)).toEqual(
        Array(3).fill({ kind: "updated", from: "0.7.0", to: "0.9.2" }),
      );
      // Each move re-checks (report-changed) before its entry is marked done.
      const signals = harness.inspection.realtimeSignals
        .filter((signal) => signal.channel !== "new-updates")
        .map((signal) => [signal.channel, signal.payload]);
      expect(signals.slice(1 /* the first check */)).toEqual([
        ["out-of-range-changed", { id: "a", state: "queued" }],
        ["out-of-range-changed", { id: "a", state: "running" }],
        ["out-of-range-changed", { id: "b", state: "queued" }],
        ["out-of-range-changed", { id: "c", state: "queued" }],
        ["report-changed", expect.anything()],
        ["out-of-range-changed", { id: "a", state: "done" }],
        ["out-of-range-changed", { id: "b", state: "running" }],
        ["report-changed", expect.anything()],
        ["out-of-range-changed", { id: "b", state: "done" }],
        ["out-of-range-changed", { id: "c", state: "running" }],
        ["report-changed", expect.anything()],
        ["out-of-range-changed", { id: "c", state: "done" }],
      ]);
    });

    it("returns the pending entry instead of queueing a plugin twice", async () => {
      const registry = fakeRegistry({ a: board("a"), b: board("b") });
      vi.mocked(listRemoteTags).mockResolvedValue(agentBoardTags);
      const installs = holdInstalls(registry);
      const { rpc } = await load(registry);
      await rpc("check");

      const first = await rpc<{ entry: QueueEntry }>("update_out_of_range", { id: "a" });
      const queued = await rpc<{ entry: QueueEntry }>("update_out_of_range", { id: "b" });
      const running = await rpc("update_out_of_range", { id: "a" });
      const waiting = await rpc("update_out_of_range", { id: "b" });

      expect(running).toEqual({ kind: "entry", entry: { ...first.entry, state: "running" } });
      expect(waiting).toEqual({ kind: "entry", entry: queued.entry });
      expect(await queue(rpc)).toHaveLength(2);
      await installs.release();
      await installs.release();
      await vi.waitFor(async () => expect(await states(rpc)).toEqual({ a: "done", b: "done" }));
      expect(installs.sources).toHaveLength(2);
    });

    it("returns manual steps right away without queueing", async () => {
      const registry = fakeRegistry({
        "agent-board": {
          ...agentBoard,
          settings: { schema: { apiKey: { type: "string", label: "API key", secret: true } }, values: {} },
        },
      });
      vi.mocked(listRemoteTags).mockResolvedValue(agentBoardTags);
      const { rpc, harness } = await load(registry);
      await rpc("check");

      const result = await rpc("update_out_of_range", { id: "agent-board" });

      expect(result).toMatchObject({ kind: "manual", reason: "secret-settings" });
      expect(await queue(rpc)).toEqual([]);
      expect(
        harness.inspection.realtimeSignals.filter((s) => s.channel === "out-of-range-changed"),
      ).toEqual([]);
    });

    it("refuses a plugin without a newer release outside its range", async () => {
      const { rpc } = await load(fakeRegistry({ homepage }));
      vi.mocked(listRemoteTags).mockResolvedValue("");
      await rpc("check");

      await expect(rpc("update_out_of_range", { id: "homepage" })).rejects.toThrow(
        "No newer release outside the range for homepage",
      );
      expect(await queue(rpc)).toEqual([]);
    });

    it("marks an update that throws as an error and moves on", async () => {
      const registry = fakeRegistry({ a: board("a"), b: board("b") });
      vi.mocked(listRemoteTags).mockResolvedValue(agentBoardTags);
      const remove = registry.plugins.remove;
      registry.plugins.remove = async (args: { pluginId: string }) => {
        if (args.pluginId === "a") throw new Error("remove exploded");
        return remove(args);
      };
      const { rpc } = await load(registry);
      await rpc("check");

      await rpc("update_out_of_range", { id: "a" });
      await rpc("update_out_of_range", { id: "b" });

      await vi.waitFor(async () => expect(await states(rpc)).toEqual({ a: "done", b: "done" }));
      expect(await queue(rpc)).toMatchObject([
        { id: "a", result: { kind: "error", error: "remove exploded" } },
        { id: "b", result: { kind: "updated" } },
      ]);
    });

    it("the CLI waits its turn behind updates queued from the page", async () => {
      const registry = fakeRegistry({ a: board("a"), b: board("b") });
      vi.mocked(listRemoteTags).mockResolvedValue(agentBoardTags);
      const installs = holdInstalls(registry);
      const { rpc, harness } = await load(registry);
      await rpc("check");

      await rpc("update_out_of_range", { id: "a" });
      const cli = harness.behavior.runCli(["update", "b", "--out-of-range"]);
      await vi.waitFor(async () => expect(await states(rpc)).toEqual({ a: "running", b: "queued" }));
      await installs.release();
      await installs.release();

      expect(await cli).toMatchObject({ exitCode: 0, stdout: "Updated b 0.7.0 → 0.9.2." });
      expect(await states(rpc)).toEqual({ a: "done", b: "done" });
    });
  });

  describe("one update at a time per plugin", () => {
    beforeEach(() => {
      vi.mocked(listRemoteTags).mockImplementation(async (url) =>
        url.includes("homepage") ? "" : agentBoardTags,
      );
    });

    it("an out-of-range update waits for the plugin's bb update job, then runs", async () => {
      const registry = fakeRegistry({ a: both("a") });
      const { rpc, harness } = await load(registry);
      await rpc("check");
      await rpc("update", { id: "a" });

      await rpc("update_out_of_range", { id: "a" });
      await vi.waitFor(async () => expect(await states(rpc)).toEqual({ a: "waiting" }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await states(rpc)).toEqual({ a: "waiting" });
      expect(registry.installed.get("a")?.source).toBe(board("a").source);

      registry.finishUpdate("a");
      await vi.waitFor(async () => expect(await states(rpc)).toEqual({ a: "done" }));
      expect((await queue(rpc))[0]?.result).toEqual({ kind: "updated", from: "0.7.0", to: "0.9.2" });
      expect(
        harness.inspection.realtimeSignals
          .filter((signal) => signal.channel === "out-of-range-changed")
          .map((signal) => (signal.payload as { state: string }).state),
      ).toEqual(["queued", "waiting", "running", "done"]);
    });

    it("an out-of-range update that waited reports the version the bb job left, not the queued one", async () => {
      const registry = fakeRegistry({ a: both("a") });
      const { rpc, harness } = await load(registry);
      await rpc("check");
      await rpc("update", { id: "a" });

      const cli = harness.behavior.runCli(["update", "a", "--out-of-range"]);
      await vi.waitFor(async () => expect(await states(rpc)).toEqual({ a: "waiting" }));
      registry.installed.get("a")!.version = "0.7.5";
      registry.finishUpdate("a");

      expect(await cli).toMatchObject({ exitCode: 0, stdout: "Updated a 0.7.5 → 0.9.2." });
      expect((await queue(rpc))[0]).toMatchObject({
        from: "0.7.5",
        result: { kind: "updated", from: "0.7.5", to: "0.9.2" },
      });
    });

    it("an out-of-range update gives up on a bb job that never ends, untouched, and the queue moves on", async () => {
      const registry = fakeRegistry({ a: both("a"), b: board("b") });
      const touched: string[] = [];
      const remove = registry.plugins.remove;
      registry.plugins.remove = async (args: { pluginId: string }) => {
        touched.push(args.pluginId);
        return remove(args);
      };
      const { rpc, harness } = await load(registry, {}, { jobWaitTimeoutMs: 50 });
      await rpc("check");
      await rpc("update", { id: "a" });

      const cli = harness.behavior.runCli(["update", "a", "--out-of-range"]);
      await vi.waitFor(async () => expect(await states(rpc)).toEqual({ a: "waiting" }));
      const next = updateOutOfRange(rpc, "b");

      expect(await cli).toMatchObject({
        exitCode: 1,
        stderr: "Gave up waiting for a's other update to finish; nothing was changed. Try again once it's done.",
      });
      expect((await queue(rpc)).find((e) => e.id === "a")?.result).toEqual({ kind: "timed-out" });
      expect(await next).toEqual({ kind: "updated", from: "0.7.0", to: "0.9.2" });
      expect(touched).toEqual(["b"]);
      expect(registry.installed.get("a")?.source).toBe(both("a").source);
    });

    it("a compatible update deferred behind a timed-out one still starts", async () => {
      const registry = fakeRegistry({ a: both("a") });
      const { rpc, harness } = await load(registry, {}, { jobWaitTimeoutMs: 100 });
      await rpc("check");
      await rpc("update", { id: "a" });
      await rpc("update_out_of_range", { id: "a" });

      expect(await rpc("update", { id: "a" })).toEqual({ kind: "deferred", id: "a" });

      await vi.waitFor(() =>
        expect(deferredSignals(harness)).toEqual([{ id: "a", outcome: "started", jobId: "job-a" }]),
      );
      expect((await queue(rpc))[0]?.result).toEqual({ kind: "timed-out" });
      expect(registry.startedUpdates).toEqual(["a", "a"]);
    });

    it("an out-of-range update goes ahead when bb's jobs can't be listed", async () => {
      const registry = fakeRegistry({ a: both("a") });
      registry.plugins.experimental_updateJobs.list = async () => {
        throw new Error("jobs unavailable");
      };
      const { rpc, harness } = await load(registry);
      await rpc("check");

      const result = await updateOutOfRange(rpc, "a");

      expect(result).toEqual({ kind: "updated", from: "0.7.0", to: "0.9.2" });
      expect(harness.inspection.logEntries).toContainEqual({
        level: "warn",
        message: "listing update jobs failed, so not waiting on a's: jobs unavailable",
      });
    });

    it("a compatible update during an out-of-range one is deferred, then started", async () => {
      const registry = fakeRegistry({ a: both("a") });
      const installs = holdInstalls(registry);
      const { rpc, harness } = await load(registry);
      await rpc("check");
      await rpc("update_out_of_range", { id: "a" });

      const request = await rpc("update", { id: "a" });
      expect(request).toEqual({ kind: "deferred", id: "a" });
      expect(registry.startedUpdates).toEqual([]);

      await installs.release();
      await vi.waitFor(() => expect(registry.startedUpdates).toEqual(["a"]));
      expect(deferredSignals(harness)).toEqual([{ id: "a", outcome: "started", jobId: "job-a" }]);
    });

    it("re-checks once a deferred update's job ends, with no page open to", async () => {
      const registry = fakeRegistry({ a: both("a") });
      const installs = holdInstalls(registry);
      const { rpc, harness } = await load(registry);
      await rpc("check");
      await rpc("update_out_of_range", { id: "a" });
      await rpc("update", { id: "a" });
      await installs.release();
      await vi.waitFor(() =>
        expect(deferredSignals(harness)).toEqual([{ id: "a", outcome: "started", jobId: "job-a" }]),
      );
      const reportChanges = () =>
        harness.inspection.realtimeSignals.filter((signal) => signal.channel === "report-changed").length;
      const before = reportChanges();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(reportChanges()).toBe(before);

      registry.installed.get("a")!.check = { outcome: "current" };
      registry.finishUpdate("a");

      await vi.waitFor(() =>
        expect(deferredSignals(harness)).toEqual([
          { id: "a", outcome: "started", jobId: "job-a" },
          { id: "a", outcome: "ended", job: expect.objectContaining({ id: "job-a", state: "completed" }) },
        ]),
      );
      expect(reportChanges()).toBe(before + 1);
      const { report } = await rpc<{ report: RpcReport }>("report");
      expect(report.compatible).toEqual([]);
    });

    it("a deferred compatible update is skipped once the plugin has none left", async () => {
      const registry = fakeRegistry({ a: both("a") });
      const install = registry.plugins.install;
      registry.plugins.install = async (args: { source: string }) => {
        const installed = await install(args);
        registry.installed.get(installed.id)!.check = { outcome: "current" };
        return installed;
      };
      const installs = holdInstalls(registry);
      const { rpc, harness } = await load(registry);
      await rpc("check");
      await rpc("update_out_of_range", { id: "a" });

      const cli = await harness.behavior.runCli(["update", "a"]);
      expect(cli).toMatchObject({
        exitCode: 0,
        stdout: "a has an out-of-range update in progress; its update starts after that, if still needed.",
      });

      await installs.release();
      await vi.waitFor(() => expect(deferredSignals(harness)).toEqual([{ id: "a", outcome: "skipped" }]));
      expect(registry.startedUpdates).toEqual([]);
    });

    it("update all defers only the plugin with an out-of-range update pending", async () => {
      const registry = fakeRegistry({ homepage, a: both("a") });
      const installs = holdInstalls(registry);
      const { rpc } = await load(registry);
      await rpc("check");
      await rpc("update_out_of_range", { id: "a" });

      const result = await rpc<{ jobs: Array<{ pluginId: string }>; deferred: string[] }>("update_all");

      expect(result).toMatchObject({ jobs: [{ pluginId: "homepage" }], deferred: ["a"] });
      expect(registry.startedUpdates).toEqual(["homepage"]);
      await installs.release();
      await vi.waitFor(() => expect(registry.startedUpdates).toEqual(["homepage", "a"]));
    });
  });

  describe("bb plugin-updates", () => {
    it("check and list show both kinds of update", async () => {
      vi.mocked(listRemoteTags).mockImplementation(async (url) =>
        url.includes("agent-board") ? agentBoardTags : "",
      );
      const { harness } = await load(fakeRegistry({ homepage, "agent-board": agentBoard }));

      const checked = await harness.behavior.runCli(["check"]);
      const listed = await harness.behavior.runCli(["list"]);

      expect(checked.exitCode).toBe(0);
      expect(listed.stdout).toBe(checked.stdout);
      expect(listed.stdout).toContain(
        "Compatible updates:\n  homepage  git:https://github.com/y/bb-homepage.git@semver:^0.2.0 (0.2.5) → bb-homepage@v0.2.7",
      );
      expect(listed.stdout).toContain(
        "Newer releases outside the installed range:\n  agent-board  0.7.0 → 0.9.2  https://github.com/a/bb-plugin-agent-board/compare/v0.7.0...v0.9.2",
      );
    });
 
    it("update starts a compatible update, and demands --out-of-range for the other kind", async () => {
      vi.mocked(listRemoteTags).mockImplementation(async (url) =>
        url.includes("agent-board") ? agentBoardTags : "",
      );
      const registry = fakeRegistry({ homepage, "agent-board": agentBoard });
      const { harness } = await load(registry);
      await harness.behavior.runCli(["check"]);

      const compatible = await harness.behavior.runCli(["update", "homepage"]);
      expect(compatible).toMatchObject({ exitCode: 0 });
      expect(compatible.stdout).toContain("Started updating homepage");
      expect(registry.startedUpdates).toEqual(["homepage"]);

      const refused = await harness.behavior.runCli(["update", "agent-board"]);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("--out-of-range");
      expect(registry.installed.get("agent-board")?.source).toBe(agentBoard.source);

      const moved = await harness.behavior.runCli(["update", "agent-board", "--out-of-range"]);
      expect(moved).toMatchObject({ exitCode: 0, stdout: "Updated agent-board 0.7.0 → 0.9.2." });
    });
 
    it("update --all starts every compatible update", async () => {
      vi.mocked(listRemoteTags).mockImplementation(async (url) =>
        url.includes("agent-board") ? agentBoardTags : "",
      );
      const registry = fakeRegistry({ homepage, "agent-board": agentBoard });
      const { harness } = await load(registry);
      await harness.behavior.runCli(["check"]);

      const result = await harness.behavior.runCli(["update", "--all"]);

      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.stdout).toContain("Started updating homepage");
      expect(registry.startedUpdates).toEqual(["homepage"]);
    });
 
    it("ignore hides a plugin's pending versions", async () => {
      vi.mocked(listRemoteTags).mockImplementation(async (url) =>
        url.includes("agent-board") ? agentBoardTags : "",
      );
      const { harness, rpc } = await load(fakeRegistry({ homepage, "agent-board": agentBoard }));
      await harness.behavior.runCli(["check"]);

      const result = await harness.behavior.runCli(["ignore", "agent-board"]);

      expect(result).toMatchObject({ exitCode: 0, stdout: "Ignoring agent-board 0.9.2." });
      expect(await rpc("report")).toMatchObject({ report: { badgeCount: 1 } });
    });
 
    it("check --reannounce toasts already-announced updates again", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue("");
      const { harness } = await load(fakeRegistry({ homepage }));
      await harness.behavior.runCli(["check"]);

      await harness.behavior.runCli(["check", "--reannounce"]);

      expect(
        harness.inspection.realtimeSignals.filter((signal) => signal.channel === "new-updates"),
      ).toHaveLength(2);
    });
 
    it("list marks disabled plugins", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue("");
      const { harness } = await load(fakeRegistry({ homepage: { ...homepage, enabled: false } }));
      await harness.behavior.runCli(["check"]);

      const listed = await harness.behavior.runCli(["list"]);

      expect(listed.stdout).toContain("  homepage (disabled)  ");
      expect(listed.stdout).toContain(
        "No enabled plugins with updates (1 disabled plugin has an update).",
      );
    });
  });
  describe("engines of releases outside the range", () => {
    type Engines = { bb?: string; bbPluginSdk?: string };
    /** Each tag's package.json engines; an Error makes reading that tag fail. */
    const manifests = (byTag: Record<string, Engines | Error>) =>
      vi.mocked(readPackageJsonAt).mockImplementation(async ({ tag }) => {
        const engines = byTag[tag] ?? {};
        if (engines instanceof Error) throw engines;
        return JSON.stringify({ name: "x", version: tag.slice(1), engines });
      });
    const boardTags = [
      `${sha(1)}\trefs/tags/v0.7.0`,
      `${sha(2)}\trefs/tags/v0.8.0`,
      `${sha(3)}\trefs/tags/v0.9.2`,
    ].join("\n");
    type EngineReport = RpcReport & {
      blocked: Array<{ id: string; version: string; reasons: string[] }>;
      releaseCheckFailures: Array<{ id: string; error: string }>;
    };

    it("reports the newest release as blocked, not offered, when this bb can't run it", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue(agentBoardTags);
      manifests({ "v0.9.2": { bb: ">=0.47" } });
      const { rpc } = await load(fakeRegistry({ "agent-board": agentBoard }), {}, { bbVersion: "0.46.1" });

      const { report } = await rpc<{ report: EngineReport }>("check");

      expect(report.outOfRange).toEqual([]);
      expect(report.blocked).toEqual([
        { id: "agent-board", version: "0.9.2", reasons: ["requires bb >=0.47, running bb is 0.46.1"] },
      ]);
      expect(report.badgeCount).toBe(0);
    });

    it("falls back to the newest older release outside the range that this bb runs", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue(boardTags);
      manifests({ "v0.9.2": { bb: ">=0.47" }, "v0.8.0": { bb: ">=0.40" } });
      const { rpc } = await load(fakeRegistry({ "agent-board": agentBoard }), {}, { bbVersion: "0.46.1" });

      const { report } = await rpc<{ report: EngineReport }>("check");

      expect(report.outOfRange).toMatchObject([
        { id: "agent-board", to: "0.8.0", newSource: "git:https://github.com/a/bb-plugin-agent-board.git@semver:^0.8.0" },
      ]);
      expect(report.blocked).toMatchObject([{ id: "agent-board", version: "0.9.2" }]);
      expect(report.badgeCount).toBe(1);
      // Newest first, stopping at the first one this bb runs.
      expect(vi.mocked(readPackageJsonAt).mock.calls.map(([args]) => args)).toEqual([
        { url: "https://github.com/a/bb-plugin-agent-board.git", tag: "v0.9.2" },
        { url: "https://github.com/a/bb-plugin-agent-board.git", tag: "v0.8.0" },
      ]);
    });

    it("ignores engines.bbPluginSdk: an SDK-only mismatch neither blocks nor refuses", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue(agentBoardTags);
      // bb's own install refuses an SDK it doesn't satisfy; that's left to it.
      manifests({ "v0.9.2": { bb: ">=0.40", bbPluginSdk: ">=99.0.0" } });
      const registry = fakeRegistry({ "agent-board": agentBoard });
      const { rpc } = await load(registry, {}, { bbVersion: "0.47.2" });

      const { report } = await rpc<{ report: EngineReport }>("check");
      const result = await updateOutOfRange(rpc, "agent-board");

      expect(report.outOfRange).toMatchObject([{ id: "agent-board", to: "0.9.2" }]);
      expect(report.blocked).toEqual([]);
      expect(report.badgeCount).toBe(1);
      expect(result).toEqual({ kind: "updated", from: "0.7.0", to: "0.9.2" });
    });

    it("offers a release whose package.json declares no engines", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue(agentBoardTags);
      manifests({});
      const { rpc } = await load(fakeRegistry({ "agent-board": agentBoard }), {}, { bbVersion: "0.46.1" });

      const { report } = await rpc<{ report: EngineReport }>("check");

      expect(report.outOfRange).toMatchObject([{ id: "agent-board", to: "0.9.2" }]);
      expect(report.blocked).toEqual([]);
      expect(report.badgeCount).toBe(1);
    });

    it("reads a multi-plugin repository's manifest from the plugin's tag and subdirectory", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue(
        `${sha(1)}\trefs/tags/taskboard/v0.3.4\n${sha(2)}\trefs/tags/taskboard/v0.4.1\n${sha(3)}\trefs/tags/v9.0.0`,
      );
      const registry = fakeRegistry({
        taskboard: {
          source: "git:https://github.com/m/bb-plugins.git@semver:taskboard/:^0.3.3",
          version: "0.3.4",
          detail: {
            range: "^0.3.3",
            tagPrefix: "taskboard/",
            resolvedTag: "taskboard/v0.3.4",
            subdirectory: "plugins/taskboard",
          },
          check: { outcome: "current" },
        },
      });
      const { rpc } = await load(registry);

      const { report } = await rpc<{ report: EngineReport }>("check");

      expect(report.outOfRange).toMatchObject([{ id: "taskboard", to: "0.4.1" }]);
      expect(readPackageJsonAt).toHaveBeenCalledWith({
        url: "https://github.com/m/bb-plugins.git",
        tag: "taskboard/v0.4.1",
        subdirectory: "plugins/taskboard",
      });
    });

    it("a manifest that can't be read fails only that plugin's release check", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue(agentBoardTags);
      vi.mocked(readPackageJsonAt).mockImplementation(async ({ url }) => {
        if (url.includes("/b.git")) throw new Error("fetch timed out");
        return "{}";
      });
      const { rpc } = await load(fakeRegistry({ a: board("a"), b: board("b") }));

      const { report } = await rpc<{ report: EngineReport }>("check");

      expect(report.outOfRange.map(({ id }) => id)).toEqual(["a"]);
      expect(report.releaseCheckFailures).toEqual([
        { id: "b", error: "couldn't read v0.9.2's package.json: fetch timed out" },
      ]);
      expect(report.badgeCount).toBe(1);
    });

    it("refuses up front to move to a release this bb can't run", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue(agentBoardTags);
      manifests({});
      const registry = fakeRegistry({ "agent-board": agentBoard });
      const { rpc } = await load(registry, {}, { bbVersion: "0.46.1" });
      await rpc("check");
      // The release changed since the check, say, or bb was downgraded.
      manifests({ "v0.9.2": { bb: ">=0.47" } });

      await expect(rpc("update_out_of_range", { id: "agent-board" })).rejects.toThrow(
        "Can't update agent-board to 0.9.2: requires bb >=0.47, running bb is 0.46.1",
      );
      expect(registry.installed.get("agent-board")?.source).toBe(agentBoard.source);
      expect(await queue(rpc)).toEqual([]);
    });

    it("refuses a queued move whose release this bb can no longer run, untouched", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue(agentBoardTags);
      let reads = 0;
      vi.mocked(readPackageJsonAt).mockImplementation(async () =>
        // Fine for the check and the preflight; not once it runs.
        JSON.stringify({ engines: ++reads > 2 ? { bb: ">=0.47" } : {} }),
      );
      const registry = fakeRegistry({ "agent-board": agentBoardWithSettings });
      const remove = vi.spyOn(registry.plugins, "remove");
      const { rpc } = await load(registry, {}, { bbVersion: "0.46.1" });
      await rpc("check");

      const result = await updateOutOfRange(rpc, "agent-board");

      expect(result).toEqual({
        kind: "rolled-back",
        error: "Can't update agent-board to 0.9.2: requires bb >=0.47, running bb is 0.46.1",
      });
      expect(remove).not.toHaveBeenCalled();
      expect(registry.installed.get("agent-board")).toMatchObject({
        source: agentBoard.source,
        settings: { values: { theme: "dark" } },
      });
    });
  });

  describe("a major release beyond a compatible update", () => {
    // The shape from an isolated run: fx@^0.1.0 on 0.1.0, tags v0.1.0, v0.1.1 and v1.0.0.
    const fxTags = [
      `${sha(1)}\trefs/tags/v0.1.0`,
      `${sha(2)}\trefs/tags/v0.1.1`,
      `${sha(3)}\trefs/tags/v1.0.0`,
    ].join("\n");
    const fx = (requested: string): FakePlugin => ({
      source: requested,
      version: "0.1.0",
      detail: { range: "^0.1.0", resolvedTag: "v0.1.0" },
      check: {
        outcome: "update-available",
        candidate: { version: sha(2), display: "https://fixture.invalid/fx@v0.1.1" },
      },
    });

    it.each([
      ["semver:^0.1.0", "git:https://fixture.invalid/fx@semver:^0.1.0"],
      ["a bare ^0.1.0", "git:https://fixture.invalid/fx@^0.1.0"],
    ])("lists v0.1.1 as compatible and v1.0.0 as out of range, counted once (%s)", async (_, requested) => {
      vi.mocked(listRemoteTags).mockResolvedValue(fxTags);
      const { rpc, harness } = await load(fakeRegistry({ fx: fx(requested) }));

      const { report } = await rpc<{ report: RpcReport & { releaseCheckFailures: unknown[] } }>("check");
      const listed = await harness.behavior.runCli(["list"]);

      expect(report.compatible).toMatchObject([{ id: "fx", version: sha(2) }]);
      expect(report.outOfRange).toMatchObject([
        {
          id: "fx",
          from: "0.1.0",
          to: "1.0.0",
          newSource: "git:https://fixture.invalid/fx@semver:^1.0.0",
          compareUrl: "https://fixture.invalid/fx/compare/v0.1.0...v1.0.0",
        },
      ]);
      expect(report.releaseCheckFailures).toEqual([]);
      expect(report.badgeCount).toBe(1);
      expect(listed.stdout).toContain("Compatible updates:\n  fx  ");
      expect(listed.stdout).toContain(
        "Newer releases outside the installed range:\n  fx  0.1.0 → 1.0.0  https://fixture.invalid/fx/compare/v0.1.0...v1.0.0",
      );
      expect(listed.stdout).toContain("1 plugin with updates.");
    });
  });

  describe("failed checks", () => {
    type Failure = { at: number; error: string };
    type Snapshot = {
      report: RpcReport;
      checkedAt: number;
      lastFailure?: Failure;
      updateCheckFailures?: Array<{ id: string; error: string }>;
    };
    const SSL =
      "HTTP 422: git ls-remote failed (exit 128): fatal: unable to access 'https://github.com/a/bb-plugin-agent-board.git/': SSL certificate problem: self signed certificate";

    /** Makes bb's update check throw: the bulk call always, a per-plugin one for `ids` (all if omitted). */
    function failChecks(registry: ReturnType<typeof fakeRegistry>, ids?: string[]) {
      registry.failCheck((id) =>
        id === undefined || ids === undefined || ids.includes(id) ? new Error(SSL) : undefined,
      );
      return { restore: () => registry.failCheck(() => undefined) };
    }

    const reportSignals = (harness: Awaited<ReturnType<typeof load>>["harness"]) =>
      harness.inspection.realtimeSignals.filter((s) => s.channel === "report-changed");

    it("keeps the last good report, records the failure, and tells open pages", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue("");
      const registry = fakeRegistry({ homepage });
      const { rpc, harness } = await load(registry);
      const good = await rpc<Snapshot>("check");
      failChecks(registry);

      await expect(rpc("check")).rejects.toThrow("SSL certificate problem");

      const after = await rpc<Snapshot>("report");
      expect(after.checkedAt).toBe(good.checkedAt);
      expect(after.report.badgeCount).toBe(1);
      expect(after.lastFailure).toEqual({ at: expect.any(Number), error: SSL });
      expect(after.lastFailure!.at).toBeGreaterThanOrEqual(good.checkedAt);
      expect(reportSignals(harness)).toHaveLength(2);
    });

    it("bounds a long failure message", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue("");
      const registry = fakeRegistry({ homepage });
      const { rpc } = await load(registry);
      await rpc("check");
      registry.failCheck(() => new Error("x".repeat(5000)));

      await expect(rpc("check")).rejects.toThrow();

      const { lastFailure } = await rpc<Snapshot>("report");
      expect(lastFailure!.error.length).toBeLessThanOrEqual(500);
      expect(lastFailure!.error.endsWith("…")).toBe(true);
    });

    it("clears the failure on the next successful check", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue("");
      const registry = fakeRegistry({ homepage });
      const { rpc } = await load(registry);
      await rpc("check");
      const failing = failChecks(registry);
      await expect(rpc("check")).rejects.toThrow();
      failing.restore();

      await rpc("check");

      const snapshot = await rpc<Snapshot>("report");
      expect(snapshot).not.toHaveProperty("lastFailure");
      expect(snapshot).not.toHaveProperty("updateCheckFailures");
    });

    it("leaves the snapshot's shape alone when nothing failed", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue("");
      const { rpc } = await load(fakeRegistry({ homepage }));

      const snapshot = await rpc<Snapshot>("check");

      expect(Object.keys(snapshot).sort()).toEqual(["checkedAt", "report"]);
    });

    it("a scheduled check logs and records the failure, and still fails for bb's status line", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue("");
      const registry = fakeRegistry({ homepage });
      const { rpc, harness } = await load(registry);
      await rpc("check");
      failChecks(registry);

      await expect(harness.behavior.runSchedule("check")).rejects.toThrow("SSL certificate problem");

      expect(harness.inspection.logEntries).toContainEqual({
        level: "warn",
        message: `scheduled check failed: ${SSL}`,
      });
      expect((await rpc<Snapshot>("report")).lastFailure?.error).toBe(SSL);
    });

    it("a check on load logs and records the failure without crashing the service", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue("");
      const registry = fakeRegistry({ homepage });
      const { rpc, harness } = await load(registry);
      await rpc("check");
      failChecks(registry);

      const service = harness.behavior.runService("check-on-load");
      await vi.waitFor(async () =>
        expect((await rpc<Snapshot>("report")).lastFailure?.error).toBe(SSL),
      );
      service.controller.abort();
      await service.done;

      expect(harness.inspection.logEntries).toContainEqual({
        level: "warn",
        message: `check on load failed: ${SSL}`,
      });
    });

    it("when bb's bulk check fails, checks plugins one by one and saves the rest", async () => {
      vi.mocked(listRemoteTags).mockImplementation(async (url) =>
        url.includes("agent-board") ? agentBoardTags : "",
      );
      const registry = fakeRegistry({ homepage, "agent-board": agentBoard });
      failChecks(registry, ["agent-board"]);
      const { rpc, harness } = await load(registry);

      const snapshot = await rpc<Snapshot>("check");

      expect(registry.checkCalls.sort()).toEqual(["agent-board", "homepage", undefined].sort());
      expect(snapshot.report.compatible.map(({ id }) => id)).toEqual(["homepage"]);
      expect(snapshot.updateCheckFailures).toEqual([{ id: "agent-board", error: SSL }]);
      expect(snapshot).not.toHaveProperty("lastFailure");
      expect(await rpc<Snapshot>("report")).toMatchObject({
        updateCheckFailures: [{ id: "agent-board", error: SSL }],
      });
      expect(harness.inspection.logEntries).toContainEqual({
        level: "warn",
        message: `update check failed, so checked each plugin; 1 of 2 failed: ${SSL}`,
      });
    });

    it("the one-by-one fallback runs at most 4 checks at once", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue("");
      const many = Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`p${i}`, { ...homepage, source: `git:https://github.com/y/p${i}.git` }]),
      );
      const registry = fakeRegistry(many);
      const checkUpdates = registry.plugins.checkUpdates;
      let running = 0;
      let peak = 0;
      registry.plugins.checkUpdates = async (args?: { pluginId?: string }) => {
        if (args?.pluginId === undefined) throw new Error(SSL);
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        return checkUpdates(args);
      };
      const { rpc } = await load(registry);

      const snapshot = await rpc<Snapshot>("check");

      expect(snapshot.report.compatible).toHaveLength(10);
      expect(peak).toBe(4);
    });

    it("counts the check as failed when every plugin's own check fails too", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue("");
      const registry = fakeRegistry({ homepage });
      const { rpc } = await load(registry);
      await rpc("check");
      failChecks(registry);

      await expect(rpc("check")).rejects.toThrow(SSL);

      expect(await rpc<Snapshot>("report")).toMatchObject({
        report: { badgeCount: 1 },
        lastFailure: { error: SSL },
      });
    });

    it("bb plugin-updates check exits 1 and shows the failure with the old results", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue("");
      const registry = fakeRegistry({ homepage });
      const { harness } = await load(registry);
      await harness.behavior.runCli(["check"]);
      failChecks(registry);

      const checked = await harness.behavior.runCli(["check"]);
      const listed = await harness.behavior.runCli(["list"]);
      const json = await harness.behavior.runCli(["check", "--json"]);

      expect(checked.exitCode).toBe(1);
      expect(checked.stderr).toBe(`Check failed: ${SSL}`);
      expect(checked.stdout).toContain("Compatible updates:\n  homepage");
      expect(checked.stdout).toMatch(/\nLast check failed .+: HTTP 422: .+\. Showing results from .+\.$/);
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toBe(checked.stdout);
      expect(json.exitCode).toBe(1);
      expect(JSON.parse(json.stdout)).toMatchObject({ lastFailure: { error: SSL } });
      expect(JSON.parse((await harness.behavior.runCli(["list", "--json"])).stdout)).toMatchObject({
        lastFailure: { error: SSL },
      });
    });

    it("bb plugin-updates check exits 1 before any check has worked", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue("");
      const registry = fakeRegistry({ homepage });
      failChecks(registry);
      const { harness } = await load(registry);

      const checked = await harness.behavior.runCli(["check"]);

      expect(checked).toMatchObject({ exitCode: 1, stderr: `Check failed: ${SSL}` });
    });

    it("bb plugin-updates lists plugins bb couldn't check", async () => {
      vi.mocked(listRemoteTags).mockResolvedValue("");
      const registry = fakeRegistry({ homepage, "agent-board": agentBoard });
      failChecks(registry, ["agent-board"]);
      const { harness } = await load(registry);

      const checked = await harness.behavior.runCli(["check"]);

      expect(checked.exitCode).toBe(0);
      expect(checked.stdout).toContain(`Couldn't check for updates:\n  agent-board  ${SSL}`);
      expect(JSON.parse((await harness.behavior.runCli(["list", "--json"])).stdout)).toMatchObject({
        updateCheckFailures: [{ id: "agent-board", error: SSL }],
      });
    });

    describe("with engines and the one-by-one fallback", () => {
      type FallbackSnapshot = Snapshot & {
        report: RpcReport & {
          blocked: Array<{ id: string; version: string; reasons: string[] }>;
          releaseCheckFailures: Array<{ id: string; error: string }>;
        };
      };
      const tags = [
        `${sha(1)}\trefs/tags/v0.7.0`,
        `${sha(2)}\trefs/tags/v0.8.0`,
        `${sha(3)}\trefs/tags/v0.9.2`,
      ].join("\n");

      it("still checks releases' engines for plugins checked one by one", async () => {
        vi.mocked(listRemoteTags).mockImplementation(async (url) => (url.includes("/a.git") ? tags : ""));
        vi.mocked(readPackageJsonAt).mockImplementation(async ({ tag }) =>
          JSON.stringify({ engines: tag === "v0.9.2" ? { bb: ">=0.47" } : { bb: ">=0.40" } }),
        );
        const registry = fakeRegistry({ homepage, a: board("a"), b: board("b") });
        failChecks(registry, ["b"]);
        const { rpc } = await load(registry, {}, { bbVersion: "0.46.1" });

        const snapshot = await rpc<FallbackSnapshot>("check");

        expect(snapshot.updateCheckFailures).toEqual([{ id: "b", error: SSL }]);
        expect(snapshot).not.toHaveProperty("lastFailure");
        expect(snapshot.report.compatible.map(({ id }) => id)).toEqual(["homepage"]);
        expect(snapshot.report.outOfRange).toMatchObject([{ id: "a", to: "0.8.0" }]);
        expect(snapshot.report.blocked).toEqual([
          { id: "a", version: "0.9.2", reasons: ["requires bb >=0.47, running bb is 0.46.1"] },
        ]);
        expect(snapshot.report.badgeCount).toBe(2);
      });

      it("shows one plugin's failed update check and another's failed release check", async () => {
        vi.mocked(listRemoteTags).mockImplementation(async (url) => {
          if (url.includes("/a.git")) throw new Error("ls-remote timed out");
          return "";
        });
        const registry = fakeRegistry({ a: board("a"), b: board("b") });
        failChecks(registry, ["b"]);
        const { rpc, harness } = await load(registry);

        const snapshot = await rpc<FallbackSnapshot>("check");

        expect(snapshot.updateCheckFailures).toEqual([{ id: "b", error: SSL }]);
        expect(snapshot.report.releaseCheckFailures).toEqual([{ id: "a", error: "ls-remote timed out" }]);
        const listed = await harness.behavior.runCli(["list"]);
        expect(listed.exitCode).toBe(0);
        expect(listed.stdout).toContain(`Couldn't check for updates:\n  b  ${SSL}`);
        expect(listed.stdout).toContain("Couldn't check for newer releases:\n  a  ls-remote timed out");
      });

      describe("for a plugin whose own update check failed", () => {
        type Full = FallbackSnapshot & {
          report: { upToDate: Array<{ id: string }>; other: Array<{ id: string }> };
        };
        /** Release ids neither up to date nor other: they have no update check entry. */
        const expectNotIdle = (snapshot: Full, ids: string[]) => {
          for (const id of ids) {
            expect(snapshot.report.upToDate.map((i) => i.id)).not.toContain(id);
            expect(snapshot.report.other.map((i) => i.id)).not.toContain(id);
          }
        };

        it("still offers its newer release outside the range, and counts it", async () => {
          vi.mocked(listRemoteTags).mockImplementation(async (url) => (url.includes("/b.git") ? tags : ""));
          const registry = fakeRegistry({ homepage, b: board("b") });
          failChecks(registry, ["b"]);
          const { rpc } = await load(registry);

          const snapshot = await rpc<Full>("check");

          expect(snapshot.updateCheckFailures).toEqual([{ id: "b", error: SSL }]);
          expect(snapshot.report.outOfRange).toEqual([
            {
              id: "b",
              from: "0.7.0",
              to: "0.9.2",
              version: "0.9.2",
              tag: "v0.9.2",
              newSource: "git:https://github.com/a/b.git@semver:^0.9.2",
              compareUrl: "https://github.com/a/b/compare/v0.7.0...v0.9.2",
            },
          ]);
          expect(snapshot.report.badgeCount).toBe(2);
          expectNotIdle(snapshot, ["b"]);
          expect(await rpc<Full>("report")).toMatchObject({ report: { outOfRange: [{ id: "b" }], badgeCount: 2 } });
        });

        it("still lists its releases this bb can't run as blocked", async () => {
          vi.mocked(listRemoteTags).mockImplementation(async (url) =>
            url.includes("/b.git") || url.includes("/c.git") ? tags : "",
          );
          vi.mocked(readPackageJsonAt).mockImplementation(async ({ url, tag }) =>
            JSON.stringify({
              engines: url.includes("/c.git") || tag === "v0.9.2" ? { bb: ">=0.47" } : { bb: ">=0.40" },
            }),
          );
          const registry = fakeRegistry({ homepage, b: board("b"), c: board("c") });
          failChecks(registry, ["b", "c"]);
          const { rpc } = await load(registry, {}, { bbVersion: "0.46.1" });

          const snapshot = await rpc<Full>("check");

          expect(snapshot.updateCheckFailures).toEqual([
            { id: "b", error: SSL },
            { id: "c", error: SSL },
          ]);
          const reasons = ["requires bb >=0.47, running bb is 0.46.1"];
          expect(snapshot.report.blocked).toEqual([
            { id: "b", version: "0.9.2", reasons },
            { id: "c", version: "0.9.2", reasons },
          ]);
          expect(snapshot.report.outOfRange).toMatchObject([{ id: "b", to: "0.8.0" }]);
          expect(snapshot.report.badgeCount).toBe(2);
          expectNotIdle(snapshot, ["b", "c"]);
        });

        it("still reports its failed release check", async () => {
          vi.mocked(listRemoteTags).mockImplementation(async (url) => {
            if (url.includes("/b.git")) throw new Error("ls-remote timed out");
            return "";
          });
          const registry = fakeRegistry({ a: board("a"), b: board("b") });
          failChecks(registry, ["b"]);
          const { rpc } = await load(registry);

          const snapshot = await rpc<Full>("check");

          expect(snapshot.updateCheckFailures).toEqual([{ id: "b", error: SSL }]);
          expect(snapshot.report.releaseCheckFailures).toEqual([{ id: "b", error: "ls-remote timed out" }]);
          expect(snapshot.report.upToDate.map((i) => i.id)).toEqual(["a"]);
          expectNotIdle(snapshot, ["b"]);
        });

        it("flags a disabled one's release without counting or announcing it", async () => {
          vi.mocked(listRemoteTags).mockImplementation(async (url) =>
            url.includes("/b.git") || url.includes("/c.git") ? tags : "",
          );
          const registry = fakeRegistry({ homepage, b: { ...board("b"), enabled: false }, c: board("c") });
          failChecks(registry, ["b", "c"]);
          const { rpc, harness } = await load(registry);

          const snapshot = await rpc<Full>("check");

          expect(snapshot.report.outOfRange).toMatchObject([
            { id: "b", to: "0.9.2", disabled: true },
            { id: "c", to: "0.9.2" },
          ]);
          expect(snapshot.report.outOfRange[1]).not.toHaveProperty("disabled");
          expect(snapshot.report.badgeCount).toBe(2);
          const toasts = harness.inspection.realtimeSignals.filter((s) => s.channel === "new-updates");
          expect(toasts.map((s) => s.payload)).toEqual([
            { updates: [{ id: "homepage", version: "dbcb6f5" }, { id: "c", version: "0.9.2" }] },
          ]);
        });

        it("bb plugin-updates list shows its release results beside the failure", async () => {
          vi.mocked(listRemoteTags).mockImplementation(async (url) => {
            if (url.includes("/d.git")) throw new Error("ls-remote timed out");
            return url.includes("homepage") ? "" : tags;
          });
          vi.mocked(readPackageJsonAt).mockImplementation(async ({ tag }) =>
            JSON.stringify({ engines: tag === "v0.9.2" ? { bb: ">=0.47" } : { bb: ">=0.40" } }),
          );
          const registry = fakeRegistry({
            homepage,
            b: board("b"),
            c: { ...board("c"), enabled: false },
            d: board("d"),
          });
          failChecks(registry, ["b", "c", "d"]);
          const { harness } = await load(registry, {}, { bbVersion: "0.46.1" });
          await harness.behavior.runCli(["check"]);

          const listed = await harness.behavior.runCli(["list"]);

          expect(listed.exitCode).toBe(0);
          expect(listed.stdout).toContain(
            `Couldn't check for updates:\n  b  ${SSL}\n  c  ${SSL}\n  d  ${SSL}\n`,
          );
          expect(listed.stdout).toContain(
            "Newer releases outside the installed range:\n" +
              "  b  0.7.0 → 0.8.0  https://github.com/a/b/compare/v0.7.0...v0.8.0\n" +
              "  c (disabled)  0.7.0 → 0.8.0  https://github.com/a/c/compare/v0.7.0...v0.8.0\n",
          );
          expect(listed.stdout).toContain(
            "Blocked by engine ranges:\n" +
              "  b  0.9.2: requires bb >=0.47, running bb is 0.46.1\n" +
              "  c  0.9.2: requires bb >=0.47, running bb is 0.46.1\n",
          );
          expect(listed.stdout).toContain("Couldn't check for newer releases:\n  d  ls-remote timed out");
          expect(listed.stdout).toContain("2 plugins with updates, plus 1 disabled.");
        });
      });
    });
  });
});

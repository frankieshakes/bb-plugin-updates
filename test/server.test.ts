import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listRemoteTags } from "../src/git";
import plugin from "../server";

vi.mock("../src/git", () => ({ listRemoteTags: vi.fn() }));

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
  return {
    installed,
    startedUpdates,
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
      checkUpdates: async () =>
        [...installed].map(([id, p]) => ({
          id,
          installed: { version: p.version, display: display(p) },
          ...p.check,
        })),
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

async function load(registry: ReturnType<typeof fakeRegistry>, settings = {}) {
  const host = createFakePluginHost({
    pluginId: "plugin-updates",
    settings,
    sdk: { plugins: registry.plugins },
  });
  await plugin(host.bb, { jobPollMs: 10 });
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
      expect(listed.stdout).toContain("No plugins with updates.");
    });
  });
});

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listRemoteTags } from "../src/git";
import plugin from "../server";

vi.mock("../src/git", () => ({ listRemoteTags: vi.fn() }));

interface FakePlugin {
  source: string;
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
  const display = (p: FakePlugin) => `${p.source} (${p.version})`;
  return {
    installed,
    startedUpdates,
    plugins: {
      experimental_updateJobs: {
        list: async () =>
          startedUpdates.map((pluginId) => ({
            id: `job-${pluginId}`,
            pluginId,
            displayName: pluginId,
            state: "running",
            phase: "activating",
          })),
      },
      experimental_startUpdate: async ({ pluginId }: { pluginId: string }) => {
        startedUpdates.push(pluginId);
        return { id: `job-${pluginId}`, pluginId, displayName: pluginId, state: "queued" };
      },
      list: async () => ({
        plugins: [...installed].map(([id, p]) => ({ id, source: p.source, version: p.version })),
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
  await plugin(host.bb);
  const rpc = async <T>(method: string, input: unknown = null) =>
    (await host.harness.behavior.callRpc(method, input)) as T;
  return { ...host, rpc };
}

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

    const result = await rpc("update_out_of_range", { id: "agent-board" });

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

    const result = await rpc("update_out_of_range", { id: "agent-board" });

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

    const result = await rpc("update_out_of_range", { id: "agent-board" });

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

    const result = await rpc("update_out_of_range", { id: "agent-board" });

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

    const result = await rpc("update_out_of_range", { id: "plugin-updates" });

    expect(result).toMatchObject({ kind: "manual", reason: "self" });
    expect(registry.installed.has("plugin-updates")).toBe(true);
  });

  it("moves a plugin with no settings without touching settings", async () => {
    const registry = fakeRegistry({ "agent-board": agentBoard });
    vi.mocked(listRemoteTags).mockResolvedValue(agentBoardTags);
    const { rpc } = await load(registry);
    await rpc("check");

    const result = await rpc("update_out_of_range", { id: "agent-board" });

    expect(result).toEqual({ kind: "updated", from: "0.7.0", to: "0.9.2" });
  });
});

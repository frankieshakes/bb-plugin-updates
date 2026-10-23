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

/** A tiny stand-in for bb's plugin registry that sdk.plugins operates on. */
function fakeRegistry(initial: Record<string, FakePlugin>) {
  const installed = new Map(Object.entries(initial));
  const display = (p: FakePlugin) => `${p.source} (${p.version})`;
  return {
    installed,
    plugins: {
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
      getSettings: async ({ pluginId }: { pluginId: string }) => ({
        ok: true,
        ...(installed.get(pluginId)!.settings ?? { schema: {}, values: {} }),
      }),
    },
  };
}

const sha = (n: number) => String(n).repeat(40);

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
});

// The one place this plugin runs git. Never prompts (a private repo without
// credentials fails fast instead of hanging) and gives up after 15s a command.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

const TIMEOUT_MS = 15_000;

function git(args: string[], cwd?: string, timeoutMs = TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        // Killed by the timeout; its message would only say "Command failed".
        else if (error.killed && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") reject(new Error(`git ${args.join(" ")} timed out after ${timeoutMs / 1000}s`));
        else reject(new Error(stderr.trim() || error.message));
      },
    );
  });
}

export function listRemoteTags(url: string, { timeoutMs = TIMEOUT_MS } = {}): Promise<string> {
  return git(["ls-remote", "--tags", url], undefined, timeoutMs);
}

/**
 * The plugin's package.json at `tag`, without a checkout: fetches just that
 * tag's commit (no history, blobs only on demand where the server allows) into
 * a temporary bare repository, which is removed afterwards.
 */
export async function readPackageJsonAt(args: {
  url: string;
  tag: string;
  subdirectory?: string;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bb-plugin-updates-"));
  try {
    await git(["init", "--bare", "--quiet", dir]);
    await git(["remote", "add", "origin", args.url], dir);
    const ref = `refs/tags/${args.tag}`;
    await git(
      ["fetch", "--quiet", "--depth=1", "--no-tags", "--filter=blob:none", "origin", `+${ref}:${ref}`],
      dir,
    );
    const path = posix.join(args.subdirectory ?? "", "package.json").replace(/^\/+/, "");
    return await git(["show", `${ref}:${path}`], dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

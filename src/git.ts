// The one place this plugin runs git. Never prompts (a private repo without
// credentials fails fast instead of hanging) and gives up after 15s.
import { execFile } from "node:child_process";

export function listRemoteTags(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["ls-remote", "--tags", url],
      {
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else reject(new Error(stderr.trim() || error.message));
      },
    );
  });
}

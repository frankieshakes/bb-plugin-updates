// Recognizes bb's own error messages where bb gives no structured field.
// Each pattern quotes the message bb 0.49.0 builds (server/dist/start-server.js);
// anything else is left as bb reported it.
import type { CheckEntry } from "./report";

/**
 * bb's update check catches what a plugin's check throws and returns that
 * plugin as `unavailable`, the error's message as `detail` (`checkRows`).
 * `unavailable` also covers results bb returns on purpose (no matching tag, a
 * moved tag, a retired marketplace, a broken release), so only these count
 * as the check having errored:
 */
const CHECK_ERRORS = [
  // runInstallCommand, which runs every git and npm command of the check:
  // `${command} ${args[0]} failed (exit ${code ?? "signal"})…`, `… timed out after ${ms}ms`,
  // `… produced more than ${n} bytes of output`
  /^(?:git|npm) \S+ (?:failed \(exit [^)]*\)|timed out after \d+ms|produced more than \d+ bytes of output)/,
  // GIT_NOT_FOUND_HINT
  /^"git" was not found on PATH/,
  // getPackument: `${packageName} registry request failed: ${detail | status}`
  /^\S+ registry request failed: /,
  /^registry returned malformed metadata for /,
  // parseLsRemote
  /^(?:malformed git ls-remote output|git ls-remote returned invalid object id)/,
  // PluginInstallCancelledError
  /^install cancelled$/,
];

/** Whether bb's entry says the check itself failed, rather than that the plugin can't be checked. */
export function isCheckError(entry: CheckEntry): boolean {
  const { outcome, detail } = entry;
  return outcome === "unavailable" && detail !== undefined && CHECK_ERRORS.some((p) => p.test(detail));
}

/**
 * bb's reason for refusing to install a release for its engines, from the
 * install's error (a failed install job carries only `error: string`).
 * bb words them `requires bb plugin SDK ${range}, running SDK is ${version}`
 * (pluginSdkRangeProblem), `requires bb ${range}, running bb is ${version}`
 * (evaluateCompatibility), `requires bb ${range}, this is ${version}`
 * (checkEngineRange) and `declares invalid engines.… range …`, after
 * "install failed: " or `install refused: plugin "<id>" `.
 */
const ENGINE_REFUSAL =
  /(requires bb plugin SDK .+?, running SDK is [\w.+-]+|requires bb .+?, (?:running bb|this) is [\w.+-]+|declares invalid engines\.(?:bb|bbPluginSdk) range .+)/;

export function engineRefusal(error: string): string | undefined {
  return ENGINE_REFUSAL.exec(error)?.[1];
}

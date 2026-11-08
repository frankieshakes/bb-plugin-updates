export const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** An error's message cut to `max` characters, for storing. */
export function boundedMessage(error: unknown, max = 500) {
  const text = message(error);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

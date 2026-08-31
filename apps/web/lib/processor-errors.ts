export function terminalRelayError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid signature|authorization (?:is )?expired|authorization.*already used/i.test(message);
}

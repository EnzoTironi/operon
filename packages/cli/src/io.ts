/**
 * CLI Terminal I/O Boundary (S01 / CLI UX)
 * Dedicated helpers for formatting and writing human-readable and JSON stdout/stderr.
 */

export function printCli(
  message?: unknown,
  ...optionalParams: unknown[]
): void {
  if (message === undefined) {
    console.log();
  } else {
    console.log(message, ...optionalParams);
  }
}

export function printCliJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function printCliError(
  message?: unknown,
  ...optionalParams: unknown[]
): void {
  if (message === undefined) {
    console.error();
  } else {
    console.error(message, ...optionalParams);
  }
}

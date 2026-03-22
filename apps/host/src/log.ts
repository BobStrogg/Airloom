/** Timestamped console logging helpers for host debug output. */

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function log(...args: unknown[]): void {
  console.log(ts(), ...args);
}

export function logError(...args: unknown[]): void {
  console.error(ts(), ...args);
}

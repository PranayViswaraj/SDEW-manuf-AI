/**
 * Work in progress that a page reload would lose (an AI read running in this tab's in-browser
 * server, unsaved table edits, an edited program). The automatic update waits while any is set.
 */
const busy = new Set<string>();

export function setBusy(key: string, on: boolean): void {
  if (on) busy.add(key);
  else busy.delete(key);
}

export function isBusy(): boolean {
  return busy.size > 0;
}

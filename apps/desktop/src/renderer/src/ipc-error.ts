/**
 * The sentence the main process wrote, without Electron's wrapping.
 *
 * An error thrown in an `ipcMain.handle` handler reaches the renderer as
 * "Error invoking remote method 'library:play': Error: <the message>". The main
 * process words its errors to be read — "Cars is no longer on MOVIEX — it may have
 * been deleted, or moved off the drive" — and a toast leading with IPC plumbing buries
 * that under something only a developer can parse.
 */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, '');
}

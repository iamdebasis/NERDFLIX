/**
 * One scan per drive at a time.
 *
 * Three things scan a drive: the Rescan button, the picker's own rescan of a drive that
 * has been reorganised, and Play looking for a file that has moved. They can land
 * together — Play pressed while the picker's rescan is still running — and two scans
 * racing to write the same title records is how a correction gets lost. So a second
 * request JOINS the scan already running.
 *
 * Except a prune. Joining a scan that does not prune would silently drop the removal
 * that was asked for, so a prune waits for the running scan and then runs itself.
 */
export function scanQueue<R>(run: (volumeId: string, prune: boolean) => Promise<R>) {
  const inFlight = new Map<string, { prune: boolean; done: Promise<R> }>();

  return (volumeId: string, prune = false): Promise<R> => {
    const running = inFlight.get(volumeId);
    if (running && (running.prune || !prune)) return running.done;

    // The earlier scan failing is no reason for the prune not to run.
    const after = running ? running.done.then(() => undefined, () => undefined) : Promise.resolve();
    const done: Promise<R> = after
      .then(() => run(volumeId, prune))
      .finally(() => {
        // Only our own entry: a prune queued behind us has already replaced it.
        if (inFlight.get(volumeId)?.done === done) inFlight.delete(volumeId);
      });
    inFlight.set(volumeId, { prune, done });
    return done;
  };
}

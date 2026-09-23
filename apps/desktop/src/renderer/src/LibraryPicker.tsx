import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ShelfFace } from './ShelfFace';
import { Wordmark } from './Wordmark';
import { ALL_LIBRARIES } from '../../shared/types';
import type {
  LibraryApi,
  LibraryCard,
  PlaybackApi,
  EnrichProgress,
  ScanProgress,
  ScanResult,
} from '../../shared/types';

/**
 * One place for the bridge types. Declaring a narrower shape here would shadow the
 * real API and silently hide methods from every other component.
 */
declare global {
  interface Window {
    libraries: LibraryApi;
    playback: PlaybackApi;
  }
}

function fmtBytes(n: number): string {
  // Decimal, to match Finder.
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(0)} GB`;
  return `${(n / 1e6).toFixed(0)} MB`;
}

/** Keep the folder name visible when a path is too long to fit. */
function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`;
}

/** A determinate bar. Numbers alone jump about; a bar reads as one continuous thing. */
function ScanBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (done / total) * 100)) : 0;
  return (
    <span
      className="scan-bar"
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {/* Indeterminate until a total is known, rather than sitting at a dead 0%. */}
      <span className={total > 0 ? '' : 'is-waiting'} style={total > 0 ? { width: `${pct}%` } : undefined} />
    </span>
  );
}

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

/**
 * "58 films · 4 shows", or just one of them. A series with forty episodes is one show:
 * counting its files would call it forty films.
 */
function describeCount(card: { titleCount: number; showCount: number }): string {
  const films = card.titleCount - card.showCount;
  const parts = [
    films > 0 ? `${films} ${plural(films, 'film')}` : null,
    card.showCount > 0 ? `${card.showCount} ${plural(card.showCount, 'show')}` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

export function LibraryPicker({
  onPick,
}: {
  onPick: (volumeId: string, label: string) => void;
}) {
  const [cards, setCards] = useState<LibraryCard[] | null>(null);
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<{ id: string; r: ScanResult } | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [enriching, setEnriching] = useState<EnrichProgress | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');

  const refresh = useCallback(async () => {
    setCards(await window.libraries.list());
  }, []);

  useEffect(() => {
    void refresh();
    void window.libraries.hasToken().then((has) => setNeedsToken(!has));
    // Plugging a drive in updates the picker without a relaunch.
    const offChanged = window.libraries.onChanged(() => void refresh());
    const offProgress = window.libraries.onScanProgress((p) =>
      setScanning(p.phase === 'done' ? null : p),
    );
    const offEnrich = window.libraries.onEnrichProgress((p) =>
      setEnriching(p.done >= p.total ? null : p),
    );
    return () => {
      offChanged();
      offProgress();
      offEnrich();
    };
  }, [refresh]);

  /**
   * Store the token and immediately use it. Editing a dotfile is not a reasonable
   * requirement, and putting it in `.env.example` — a template that is never read —
   * looks exactly like the app being broken.
   */
  const saveToken = async () => {
    if (!tokenDraft.trim()) return;
    await window.libraries.setToken(tokenDraft);
    setTokenDraft('');
    setNeedsToken(false);
    const e = await window.libraries.enrich();
    setNeedsToken(e.skipped === 'no-token');
    await refresh();
  };

  /** Rescan every real library in turn. Sequential, so progress stays readable. */
  const scanAll = async () => {
    for (const c of (cards ?? []).filter((x) => !x.combined && x.connected)) {
      await scan(c);
    }
  };

  const scan = async (card: LibraryCard, prune = false) => {
    setScanError(null);
    setResult(null);
    // Show the scanning state on click rather than waiting for the first progress
    // event. Without this the status region empties for a beat and the whole block
    // flickers out and back in, which is the flash rather than the layout.
    setScanning({ volumeId: card.id, done: 0, total: 0, current: '', phase: 'scanning' });
    try {
      const r = await window.libraries.scan(card.id, prune);
      setResult({ id: card.id, r });
      await refresh();

      // Straight into artwork. A library of grey rectangles is not worth looking at,
      // and making that a separate step people have to know about is a poor default.
      if (r.created > 0 || r.alreadyKnown > 0) {
        const e = await window.libraries.enrich();
        setNeedsToken(e.skipped === 'no-token');
        await refresh();
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(null);
    }
  };

  const add = async () => {
    setBusy(true);
    try {
      const id = await window.libraries.add();
      if (id) await refresh();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await window.libraries.remove(id);
    await refresh();
  };

  if (cards === null) {
    return (
      <div className="screen">
        <p className="loading">Checking your drives…</p>
      </div>
    );
  }

  // Empty state is an invitation, not an apology.
  if (cards.length === 0) {
    return (
      <div className="screen">
        <div className="stack">
          {/* The mark belongs on the first screen too — it is the first thing anyone
              sees, and its absence here made the empty state look like a different app. */}
          <Wordmark className="picker-mark" size={30} />
          <div>
            <h1 className="headline">Let's find your films.</h1>
            <p className="subhead">
              Point this at a folder of films or TV — an external drive, a NAS share, anywhere. It
              reads what's there and leaves your files exactly as they are.
            </p>
          </div>
          <button className="primary-button" onClick={add} disabled={busy}>
            {busy ? 'Choosing…' : 'Choose a folder'}
          </button>
        </div>
      </div>
    );
  }

  const connected = cards.filter((c) => c.connected).length;

  /**
   * What the status region is saying right now.
   *
   * Ordered by urgency and deliberately exclusive: an error outranks live progress,
   * live progress outranks a finished result. The `key` drives the cross-fade — it
   * changes when the KIND of message changes, never on a progress tick, so a counter
   * ticking upward does not restart the animation on every file.
   */
  const scanningCard = scanning ? cards.find((c) => c.id === scanning.volumeId) : null;
  const status: { key: string; node: ReactNode } | null = scanError
    ? { key: 'error', node: <p className="scan-error">{scanError}</p> }
    : scanning
      ? {
          key: 'scanning',
          node: (
            <div className="scan-live">
              <p className="scan-live-head">
                {scanning.phase === 'saving' ? 'Saving' : 'Reading'}
                {scanningCard ? <> <strong>{scanningCard.label}</strong></> : null}
                {scanning.total > 0 && (
                  <span className="scan-count">
                    {scanning.done}/{scanning.total}
                  </span>
                )}
              </p>
              <ScanBar done={scanning.done} total={scanning.total} />
              {/* One ellipsised line. A filename changing length several times a second
                  reflows the whole block otherwise. */}
              <span className="scan-file">{scanning.current || '\u00a0'}</span>
            </div>
          ),
        }
      : enriching
        ? {
            key: 'enrich',
            node: (
              <div className="scan-live">
                <p className="scan-live-head">
                  Fetching artwork
                  <span className="scan-count">
                    {enriching.done}/{enriching.total}
                  </span>
                </p>
                <ScanBar done={enriching.done} total={enriching.total} />
                <span className="scan-file">{enriching.current || '\u00a0'}</span>
              </div>
            ),
          }
        : result
          ? {
              key: 'result',
              node: (
                <div className="scan-result">
                  <strong>
                    {result.r.created > 0 && `${result.r.created} new`}
                    {result.r.created > 0 && result.r.moved > 0 && ' \u00b7 '}
                    {result.r.moved > 0 && `${result.r.moved} moved`}
                    {result.r.created === 0 && result.r.moved === 0 && 'Up to date'}
                  </strong>
                  <span>
                    {result.r.unchanged} unchanged {'\u00b7'}{' '}
                    {(result.r.elapsedMs / 1000).toFixed(1)}s
                  </span>

                  {result.r.missing.length > 0 && result.r.pruned === 0 && (
                    <div className="scan-missing">
                      <p>
                        {result.r.missing.length} file
                        {result.r.missing.length === 1 ? '' : 's'} no longer on the drive:
                      </p>
                      <ul>
                        {result.r.missing.slice(0, 4).map((m) => (
                          <li key={m.relPath}>{m.title}</li>
                        ))}
                        {result.r.missing.length > 4 && (
                          <li>{'\u2026'}and {result.r.missing.length - 4} more</li>
                        )}
                      </ul>
                      <button
                        className="ghost-button small"
                        onClick={() => {
                          const card = cards.find((c) => c.id === result.id);
                          if (card) void scan(card, true);
                        }}
                      >
                        Remove these records
                      </button>
                    </div>
                  )}
                  {result.r.pruned > 0 && <span>{result.r.pruned} record(s) removed</span>}
                </div>
              ),
            }
          : null;

  return (
    <div className="screen">
      <div className="stack">
        <div>
          <Wordmark className="picker-mark" size={30} />
        <h1 className="headline">Where are we watching from?</h1>
          {connected < cards.length && (
            <p className="subhead">
              {cards.length - connected === 1
                ? 'One drive isn’t connected. Everything on it is still listed.'
                : `${cards.length - connected} drives aren’t connected. Everything on them is still listed.`}
            </p>
          )}
        </div>

        <div className="picker-row">
          {cards.map((card) => (
            <div key={card.id} className={`card-slot${card.combined ? ' is-combined' : ''}`}>
            <button
              className={`card${card.connected ? '' : ' offline'}`}
              onClick={() => (managing ? void window.libraries.reveal(card.path) : onPick(card.id, card.label))}
              title={card.path}
            >
              <div className="face">
                <ShelfFace
                  seed={card.id}
                  titleCount={card.titleCount}
                  mixSeeds={card.combined ? card.shelfSeeds : undefined}
                />
                {!card.connected && <span className="badge">Not connected</span>}
                {card.connected && card.relocated && <span className="badge">Moved — found it</span>}
                {managing && !card.combined && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="remove-button"
                    aria-label={`Remove ${card.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(card.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') void remove(card.id);
                    }}
                  >
                    ×
                  </span>
                )}
              </div>

              <span className="name">{card.label}</span>
              <span className="meta">
                {card.titleCount === 0 ? 'Not scanned yet' : `${describeCount(card)} · ${fmtBytes(card.totalBytes)}`}
              </span>
              {card.combined ? (
                <>
                  <span className="meta meta-path">{card.path}</span>
                  {card.duplicateCount ? (
                    <span className="meta meta-duplicates">
                      {`${card.duplicateCount} ${card.showCount > 0 ? plural(card.duplicateCount, 'title') : plural(card.duplicateCount, 'film')} on two drives, counted once`}
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="meta meta-path">{shortPath(card.path)}</span>
              )}
            </button>

            {/* Deliberately a sibling of the card, not a child: nesting a button
                inside a button means a near-miss opens the library instead of
                scanning, and it is invalid HTML. */}
            {card.connected && !managing && (
              <button
                className="scan-button"
                disabled={scanning !== null}
                onClick={() => void (card.combined ? scanAll() : scan(card))}
              >
                {scanning?.volumeId === card.id
                  ? scanning.phase === 'saving'
                    ? 'Saving…'
                    : // "0/0" until the walk has counted the files — a meaningless
                      // fraction, and the first thing you see after clicking.
                      scanning.total > 0
                      ? `${scanning.done}/${scanning.total}`
                      : 'Reading…'
                  : card.neverScanned
                    ? 'Scan'
                    : 'Rescan'}
              </button>
            )}
            </div>
          ))}

          <div className="card-slot">
          <button className="card" onClick={add} disabled={busy}>
            <div className="add-face">
              <svg className="plus" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 5v14M5 12h14"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <span className="name">Add a folder</span>
          </button>
          </div>
        </div>

        {/*
          ONE region for everything transient, with its height reserved.

          These were four separate conditional blocks stacked in a centred column, so
          each appearance and disappearance re-centred the whole page — the cards
          jumped every time a scan started, finished, began fetching artwork, or
          errored. Reserving the space means the common cases move nothing at all, and
          the states cross-fade into one another instead of the block blinking out and
          back in.
        */}
        <div className="picker-status" aria-live="polite">
          {status && (
            <div key={status.key} className="picker-status-item">
              {status.node}
            </div>
          )}
        </div>

        {needsToken && (
          <div className="token-prompt">
            <p>Paste a TMDB read token to fetch posters, backdrops and descriptions.</p>
            <div className="token-row">
              <input
                type="password"
                value={tokenDraft}
                placeholder="eyJhbGciOiJIUzI1NiJ9…"
                onChange={(e) => setTokenDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveToken();
                }}
                aria-label="TMDB read token"
              />
              <button className="ghost-button small" onClick={() => void saveToken()}>
                Save
              </button>
            </div>
            <span>Free from themoviedb.org → Settings → API → API Read Access Token</span>
          </div>
        )}

        <div className="actions">
          <button className="ghost-button" onClick={() => setManaging((m) => !m)}>
            {managing ? 'Done' : 'Manage libraries'}
          </button>
        </div>

        {managing && <p className="hint">Click a card to show it in Finder, or × to remove it.</p>}
      </div>
    </div>
  );
}

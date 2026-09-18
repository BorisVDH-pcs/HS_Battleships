import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, adminRevokeEvidence } from '../lib/supabase.js';
import { signedUrls } from '../lib/evidence.js';
import { coordLabel, fromPosition } from '../lib/board.js';
import { millionsLabel } from '../lib/millions.js';
import { useConfirm } from './ConfirmDialog.jsx';

/**
 * The organiser's read of every piece of evidence in a game.
 *
 * There is no approve or reject here on purpose: uploading is what unlocks the
 * shot, and the game does not stop to wait on a queue mid-event. This exists so
 * that a disputed tile can be settled by looking, and so a team that is inventing
 * completions can be caught. Nothing on this screen is destructive.
 *
 * It names the tile and the team side by side, which is exactly what a player
 * must never see across the line — admin_list_evidence() refuses anyone who is
 * not an admin, so this is gated at the database, not by hiding the component.
 *
 * ---- why it pages, and why it signs a page at a time ----
 *
 * The bucket is private, so every image needs a signed URL, and those expire
 * after an hour. This screen used to mint one for every row in the game the
 * moment it mounted and never mint another — which fails twice over. A game's
 * worth of screenshots is several hundred full-size images rendered at once,
 * and an organiser who leaves the tab open through an event (which is what
 * this tab is for) comes back after the hour to a screen of broken images and
 * no reason given. EvidencePanel had this right for one tile and said so in a
 * comment; this is the same lesson applied to the list.
 *
 * So: the rows are fetched once — the metadata is small and it is what the
 * filters are built from — and only the page on screen is ever signed. Coming
 * back to a stale tab re-signs it.
 *
 * The filters are the other half of the same problem. The screen exists to
 * settle a dispute, and a dispute is about one tile; scrolling a whole event
 * to find it is not reading, it is searching by eye.
 *
 * ---- the one destructive thing on it ----
 *
 * Revoke (20260918163924) is the exception to "nothing on this screen is
 * destructive", and it is here because this is the screen where the mistake is
 * found: the row shows the screenshot next to the drop it was filed as, which
 * is what a mis-pick actually looks like — the right picture against the wrong
 * name.
 *
 * Every press previews first. `admin_revoke_evidence` refuses nothing, so the
 * dialog is the only thing between an organiser and a withdrawn shot, a
 * refloated ship or a reopened game; the preview is that same function run
 * against the real rows and rolled back, so the list it prints is what will
 * happen rather than a second guess at it.
 */

/** Rows per page. Enough to scan, few enough to sign and paint at once. */
const PAGE = 30;

/**
 * When a page's URLs are old enough to be worth replacing.
 *
 * Under the hour they are minted for, with room to spare: the check runs when
 * the tab is looked at, so it has to be comfortably early rather than exactly
 * right — a URL that expires two minutes after the check passes is still a
 * broken image.
 */
const RESIGN_AFTER_MS = 45 * 60 * 1000;

/**
 * What a submission was filed as — the half of the row that a mis-pick is
 * actually visible in.
 *
 * A `value` tile's `points` is tenths of a million (20260913040000), so it
 * goes through millionsLabel like every other screen. A set tile's is always
 * 1 and saying so is noise: what matters there is which piece it was. A tile
 * with no drop list at all has nothing to name, and returns null rather than
 * an empty badge.
 */
function submissionLabel(r) {
  if (r.completion === 'value') return `${millionsLabel(r.points)}m`;
  if (!r.option_label) return null;
  if (r.completion === 'one_set' || r.completion === 'each_set') return r.option_label;
  return `${r.option_label} · ${r.points} pt${r.points === 1 ? '' : 's'}`;
}

/**
 * The preview, as sentences.
 *
 * Every line comes from a field `admin_revoke_evidence` filled in while doing
 * the real work, so this narrates the rollback rather than predicting it. The
 * order is deliberate: what happens to the shot, then to the board, then to
 * the match, then the one thing that is merely untidy.
 */
function consequences(p) {
  const out = [];

  if (p.unfired) {
    out.push(p.shot_result === 'hit'
      ? 'The shot is withdrawn — that HIT stops counting.'
      : 'The shot is withdrawn — that miss stops counting.');
    // Not "goes back to active". It is unlocked: the tile and every other
    // screenshot on it survive, but it holds no slot and takes no evidence
    // until the team locks it in again — which is what keeps a revoke from
    // handing them a fourth active tile.
    out.push(p.parked
      ? `The tile is unlocked, keeping its progress. ${p.team_name} must lock it in again — costing a slot — before they can submit against it.`
      : 'The tile goes back to active, so the team can submit against it again.');
  } else if (p.was_fired) {
    out.push('The tile still meets its target without this piece, so the shot stands and the board does not move.');
  }

  if (p.ship_refloated) out.push(`A ${p.ship_size}-tile ship is no longer sunk.`);
  if (p.reveals_withdrawn > 0) {
    out.push(p.reveals_withdrawn === 1
      ? 'The free square revealed around that ship is taken back.'
      : `The ${p.reveals_withdrawn} free squares revealed around that ship are taken back.`);
  }
  if (p.game_reopened) out.push(`The game is reopened — ${p.team_name} loses the win.`);

  // Who sees what, said out loud. The organiser is deciding whether to press
  // this in the middle of a live event, and "does the other team find out"
  // is the question they will actually have — worth answering in the dialog
  // rather than leaving them to reason about RLS policies.
  out.push(p.announced_to_all
    ? `The other team is told a shot was withdrawn — not which square, which tile, or what was on it.`
    : `The other team is told nothing.`);
  if (p.over_slot_limit) {
    out.push(`${p.team_name} will be holding ${p.active_tiles} tiles, over the limit of ${p.max_active_tiles}.`);
  }

  // Said in the unit the tile is actually scored in. "0 pieces of evidence" is
  // true of a points tile and tells the organiser nothing about how far off it
  // now is; `points_per_set` is left out because its target is per group, so a
  // single "of N" would be a lie.
  if (p.completion === 'value') {
    out.push(`${p.team_name} is left with ${millionsLabel(p.points_left)}m of the ${millionsLabel(p.required_evidence)}m this tile needs.`);
  } else if (p.completion === 'points') {
    out.push(`${p.team_name} is left with ${p.points_left} of the ${p.required_evidence} points this tile needs.`);
  } else {
    out.push(`${p.team_name} is left with ${p.evidence_left} piece${p.evidence_left === 1 ? '' : 's'} of evidence on this tile.`);
  }

  return out;
}

export default function EvidenceReview({ gameId }) {
  const [rows, setRows] = useState([]);
  const [urls, setUrls] = useState({});
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const [team, setTeam] = useState('');
  const [player, setPlayer] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  // Bumped after a successful revoke, to refetch the list. The row is gone and
  // the claim beside it may have changed status, so nothing local can be
  // patched up honestly — the list is small and comes back in one call.
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(null);
  const [confirm, confirmDialog] = useConfirm();

  // Kept apart from `error`, which is a failure to LOAD and replaces the
  // screen. A revoke that is refused must not take the list with it — the
  // organiser is mid-dispute and still needs to see the evidence.
  const [actionError, setActionError] = useState(null);

  const mintedAt = useRef(0);
  // Bumped per signing run, so a slow reply for a page already left cannot
  // paint its URLs over the page now on screen.
  const signSeq = useRef(0);

  useEffect(() => {
    if (!gameId) { setRows([]); return undefined; }
    let cancelled = false;
    setLoading(true);
    supabase
      .rpc('admin_list_evidence', { p_game_id: gameId })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) { setError(err.message); return; }
        setRows(data ?? []);
        setError(null);
      })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [gameId, tick]);

  const teams = useMemo(
    () => [...new Set(rows.map((r) => r.team_name).filter(Boolean))].sort(),
    [rows]
  );
  const players = useMemo(
    () => [...new Set(rows.map((r) => r.uploaded_by_name).filter(Boolean))].sort(),
    [rows]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (team && r.team_name !== team) return false;
      if (player && r.uploaded_by_name !== player) return false;
      if (!q) return true;
      // The coordinate is searched as well as the name, because a dispute
      // arrives as "what did they send for H7", not as a tile's wording.
      const { row, col } = fromPosition(r.tile_position);
      return `${r.tile_name ?? ''} ${coordLabel(row, col)}`.toLowerCase().includes(q);
    });
  }, [rows, team, player, query]);

  // A filter narrowing the list under a page you had scrolled to would leave
  // you on an empty page 4 of 1.
  useEffect(() => { setPage(0); }, [team, player, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE));
  const shown = filtered.slice(page * PAGE, page * PAGE + PAGE);

  // The identity of what is on screen, as a plain string so the effect below
  // re-runs on a genuine change of page rather than on every render.
  const pageKey = shown.map((r) => r.storage_path).join('\n');

  const sign = useCallback(async (paths) => {
    if (!paths.length) { setUrls({}); return; }
    const seq = ++signSeq.current;
    try {
      const map = await signedUrls(paths);
      if (seq !== signSeq.current) return;
      setUrls(map);
      mintedAt.current = Date.now();
      setError(null);
    } catch (e) {
      if (seq === signSeq.current) setError(e.message);
    }
  }, []);

  useEffect(() => {
    sign(pageKey ? pageKey.split('\n') : []);
  }, [pageKey, sign]);

  // Coming back to a tab that has been open past the expiry. Same pair of
  // listeners the board uses, and for the same reason: only visibilitychange
  // covers a phone unlocking, only focus covers a desktop alt-tab.
  useEffect(() => {
    if (!pageKey) return undefined;
    const recheck = () => {
      if (document.hidden) return;
      if (Date.now() - mintedAt.current < RESIGN_AFTER_MS) return;
      sign(pageKey.split('\n'));
    };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [pageKey, sign]);

  /**
   * Preview, ask, then do it.
   *
   * Two calls to the same RPC. The first is the dry run, and its answer is the
   * dialog; the second is the same function without the rollback. They are not
   * one transaction, so in principle the tile could move between them — a team
   * member landing a screenshot in the half-second the dialog is open. That is
   * survivable rather than guarded: the second call re-reads everything and
   * takes the claim's row lock, so it acts on the state it finds rather than
   * the state that was described, and the worst case is a dialog that
   * overstated what happened. Locking the claim for the length of a human
   * decision is the alternative, and it would block the team mid-event.
   */
  const revoke = useCallback(async (r) => {
    setBusy(r.id);
    try {
      const p = await adminRevokeEvidence(r.id, true);
      const { row, col } = fromPosition(r.tile_position);
      const filed = submissionLabel(r);

      const ok = await confirm(
        <>
          <strong>{r.tile_name}</strong> {coordLabel(row, col)} — {r.team_name},
          {' '}submitted by {r.uploaded_by_name}
          {filed ? <> and filed as <strong>{filed}</strong></> : null}.
          {consequences(p).map((line) => (
            <span key={line}><br />{line}</span>
          ))}
        </>,
        {
          title: 'Revoke this submission?',
          confirmLabel: 'Revoke it',
          danger: true,
        },
      );
      if (!ok) return;

      await adminRevokeEvidence(r.id, false);
      setTick((t) => t + 1);
      setActionError(null);
    } catch (e) {
      setActionError(e.message);
    } finally {
      setBusy(null);
    }
  }, [confirm]);

  if (error) return <p className="error">{error}</p>;
  if (loading) return <p className="muted">Loading evidence…</p>;
  if (!rows.length) return <p className="muted">No evidence submitted yet.</p>;

  const filtering = Boolean(team || player || query.trim());

  return (
    <>
      {confirmDialog}
      {actionError && <p className="error">{actionError}</p>}

      <div className="evidence-filters">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Tile name or square"
          aria-label="Filter by tile"
        />
        <select value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Filter by team">
          <option value="">Both teams</option>
          {teams.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={player} onChange={(e) => setPlayer(e.target.value)} aria-label="Filter by player">
          <option value="">Everyone</option>
          {players.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        {filtering && (
          <button
            className="ghost"
            onClick={() => { setTeam(''); setPlayer(''); setQuery(''); }}
          >
            Clear
          </button>
        )}
        <span className="muted">
          {filtering
            ? `${filtered.length} of ${rows.length}`
            : `${rows.length} submitted`}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="muted">Nothing matches that.</p>
      ) : (
        <>
          <ul className="evidence-review">
            {shown.map((r) => {
              const { row, col } = fromPosition(r.tile_position);
              const filed = submissionLabel(r);
              return (
                <li key={r.id}>
                  <a href={urls[r.storage_path]} target="_blank" rel="noreferrer">
                    {urls[r.storage_path]
                      ? <img
                          src={urls[r.storage_path]}
                          alt={`Submitted by ${r.uploaded_by_name} for ${r.tile_name}`}
                          loading="lazy"
                        />
                      : <span className="evidence-pending" />}
                  </a>
                  <div className="meta">
                    <strong>{r.tile_name}</strong>
                    <span className="coord">{coordLabel(row, col)}</span>
                    {/* The drop it was filed as, beside the picture of the
                        drop it actually shows. A mis-pick is only visible as
                        the two disagreeing, so this is the whole reason the
                        screen can settle one. */}
                    {filed && <span className="evidence-filed">{filed}</span>}
                    <span className="muted">
                      {r.team_name} · {r.uploaded_by_name} ·{' '}
                      {new Date(r.created_at).toLocaleString()}
                      {r.status === 'fired' ? ' · fired' : ' · not yet fired'}
                    </span>
                  </div>
                  <button
                    className="ghost danger evidence-revoke"
                    disabled={busy !== null}
                    onClick={() => revoke(r)}
                    aria-label={`Revoke ${r.uploaded_by_name}'s submission for ${r.tile_name}`}
                  >
                    {busy === r.id ? 'Checking…' : 'Revoke'}
                  </button>
                </li>
              );
            })}
          </ul>

          {pageCount > 1 && (
            <div className="evidence-pager">
              <button
                className="ghost"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                ← Newer
              </button>
              <span className="muted">Page {page + 1} of {pageCount}</span>
              <button
                className="ghost"
                disabled={page >= pageCount - 1}
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              >
                Older →
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

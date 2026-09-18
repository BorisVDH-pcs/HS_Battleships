/**
 * Stand-in for lib/supabase.js, used ONLY by the evidence-review harness.
 *
 * There is no local Postgres on this machine and the dev server's Supabase is
 * the live project, so the revoke flow cannot be exercised end to end without
 * applying the migrations to the real event database. This replaces the two
 * calls EvidenceReview makes — `admin_list_evidence` and `admin_revoke_evidence`
 * — with canned answers, so the REAL component, the REAL confirm dialog and the
 * REAL stylesheet render exactly what an organiser would see.
 *
 * The dry-run payloads below are hand-written to the shape
 * `admin_revoke_evidence` returns (see 20260918163924, the `v_out` object).
 * They are a fixture, not a simulation: nothing here runs the completion rules,
 * so this shows what the screen LOOKS like, and proves nothing about whether
 * the SQL unwinds a sinking correctly.
 *
 * Swapped in by vite.preview.config.js. The app build never sees this file.
 */

/** A grey placeholder in the shape of a screenshot thumbnail. */
const shot = (label) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="168" height="168">
       <rect width="168" height="168" fill="#2a2a2c"/>
       <rect x="8" y="8" width="152" height="152" fill="none" stroke="#3d3d40"/>
       <text x="84" y="80" fill="#8a8a8f" font-family="system-ui" font-size="15"
             text-anchor="middle">screenshot</text>
       <text x="84" y="102" fill="#f2c14e" font-family="system-ui" font-size="13"
             text-anchor="middle">${label}</text>
     </svg>`
  );

const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();

/**
 * Six rows, each a different thing a revoke can do. The first is the case this
 * feature was actually asked for; the rest get progressively more destructive,
 * which is the order the dialog has to be legible in.
 */
export const DEMO = [
  {
    id: 'ev-1',
    claim_id: 'cl-1',
    storage_path: 'p/1',
    uploaded_by_name: 'Sanchez',
    created_at: ago(4),
    team_id: 't-a',
    team_name: 'Kandarin',
    tile_position: 63,
    tile_name: 'Infernal cape, fire cape and quiver',
    status: 'active',
    option_label: 'Fire cape',
    points: 2,
    completion: 'points',
    required_evidence: 10,
    public_url: null,
    _preview: {
      dry_run: true, position: 63, tile_name: 'Infernal cape, fire cape and quiver',
      completion: 'points', required_evidence: 10, team_name: 'Kandarin',
      evidence_left: 3, points_left: 6, still_complete: false,
      was_fired: false, shot_result: null,
      unfired: false, parked: false, announced_to_all: false, ship_refloated: false, ship_size: null,
      reveals_withdrawn: 0, game_reopened: false,
      active_tiles: 3, max_active_tiles: 3, over_slot_limit: false,
    },
  },
  {
    id: 'ev-2',
    claim_id: 'cl-2',
    storage_path: 'p/2',
    uploaded_by_name: 'Thammaron',
    created_at: ago(26),
    team_id: 't-a',
    team_name: 'Kandarin',
    tile_position: 27,
    tile_name: 'Any three barrows pieces',
    status: 'fired',
    option_label: "Dharok's helm",
    points: 4,
    completion: 'points',
    required_evidence: 10,
    public_url: null,
    _preview: {
      dry_run: true, position: 27, tile_name: 'Any three barrows pieces',
      completion: 'points', required_evidence: 10, team_name: 'Kandarin',
      evidence_left: 3, points_left: 10, still_complete: true,
      was_fired: true, shot_result: 'miss',
      unfired: false, parked: false, announced_to_all: false, ship_refloated: false, ship_size: null,
      reveals_withdrawn: 0, game_reopened: false,
      active_tiles: 2, max_active_tiles: 3, over_slot_limit: false,
    },
  },
  {
    id: 'ev-3',
    claim_id: 'cl-3',
    storage_path: 'p/3',
    uploaded_by_name: 'Nieve',
    created_at: ago(51),
    team_id: 't-b',
    team_name: 'Misthalin',
    tile_position: 8,
    tile_name: '15M worth of Revenant emblems',
    status: 'fired',
    option_label: null,
    points: 55,
    completion: 'value',
    required_evidence: 150,
    public_url: null,
    _preview: {
      dry_run: true, position: 8, tile_name: '15M worth of Revenant emblems',
      completion: 'value', required_evidence: 150, team_name: 'Misthalin',
      evidence_left: 6, points_left: 98, still_complete: false,
      was_fired: true, shot_result: 'miss',
      unfired: true, parked: true, announced_to_all: true, ship_refloated: false, ship_size: null,
      reveals_withdrawn: 0, game_reopened: false,
      active_tiles: 3, max_active_tiles: 3, over_slot_limit: false,
    },
  },
  {
    id: 'ev-4',
    claim_id: 'cl-4',
    storage_path: 'p/4',
    uploaded_by_name: 'Duradel',
    created_at: ago(73),
    team_id: 't-b',
    team_name: 'Misthalin',
    tile_position: 41,
    tile_name: 'Any godsword hilt',
    status: 'fired',
    option_label: 'Bandos hilt',
    points: 3,
    completion: 'points',
    required_evidence: 6,
    public_url: null,
    _preview: {
      dry_run: true, position: 41, tile_name: 'Any godsword hilt',
      completion: 'points', required_evidence: 6, team_name: 'Misthalin',
      evidence_left: 1, points_left: 3, still_complete: false,
      was_fired: true, shot_result: 'hit',
      unfired: true, parked: true, announced_to_all: true, ship_refloated: false, ship_size: null,
      reveals_withdrawn: 0, game_reopened: false,
      active_tiles: 2, max_active_tiles: 3, over_slot_limit: false,
    },
  },
  {
    id: 'ev-5',
    claim_id: 'cl-5',
    storage_path: 'p/5',
    uploaded_by_name: 'Vannaka',
    created_at: ago(95),
    team_id: 't-a',
    team_name: 'Kandarin',
    tile_position: 55,
    tile_name: 'One of each Nightmare unique',
    status: 'fired',
    option_label: "Inquisitor's mace",
    points: 1,
    completion: 'each_set',
    required_evidence: 1,
    public_url: null,
    _preview: {
      dry_run: true, position: 55, tile_name: 'One of each Nightmare unique',
      completion: 'each_set', required_evidence: 1, team_name: 'Kandarin',
      evidence_left: 4, points_left: 4, still_complete: false,
      was_fired: true, shot_result: 'hit',
      unfired: true, parked: true, announced_to_all: true, ship_refloated: true, ship_size: 4,
      reveals_withdrawn: 12, game_reopened: false,
      active_tiles: 3, max_active_tiles: 3, over_slot_limit: false,
    },
  },
  {
    id: 'ev-6',
    claim_id: 'cl-6',
    storage_path: 'p/6',
    uploaded_by_name: 'Sanchez',
    created_at: ago(140),
    team_id: 't-a',
    team_name: 'Kandarin',
    tile_position: 100,
    tile_name: 'Any Chambers of Xeric unique',
    status: 'fired',
    option_label: 'Twisted bow',
    points: 8,
    completion: 'points',
    required_evidence: 8,
    public_url: null,
    _preview: {
      dry_run: true, position: 100, tile_name: 'Any Chambers of Xeric unique',
      completion: 'points', required_evidence: 8, team_name: 'Kandarin',
      evidence_left: 0, points_left: 0, still_complete: false,
      was_fired: true, shot_result: 'hit',
      unfired: true, parked: true, announced_to_all: true, ship_refloated: true, ship_size: 2,
      reveals_withdrawn: 6, game_reopened: true,
      active_tiles: 2, max_active_tiles: 3, over_slot_limit: false,
    },
  },
];

/** Rows the harness has not revoked yet. Mutated so the list really shrinks. */
let live = [...DEMO];

export const resetDemo = () => { live = [...DEMO]; };

export const supabase = {
  rpc(name) {
    if (name === 'admin_list_evidence') {
      return Promise.resolve({ data: live.map(({ _preview, ...r }) => r), error: null });
    }
    return Promise.resolve({ data: null, error: { message: `stub: no ${name}` } });
  },
};

export function adminRevokeEvidence(evidenceId, dryRun = false) {
  const row = live.find((r) => r.id === evidenceId);
  if (!row) return Promise.reject(new Error('No such piece of evidence'));
  if (!dryRun) live = live.filter((r) => r.id !== evidenceId);
  // A beat of latency, so the button's "Checking…" state is actually visible.
  return new Promise((resolve) =>
    setTimeout(() => resolve({ ...row._preview, dry_run: dryRun }), 220)
  );
}

export const DEMO_URLS = Object.fromEntries(
  DEMO.map((r) => [r.storage_path, shot(r.option_label ?? `${r.points / 10}m`)])
);

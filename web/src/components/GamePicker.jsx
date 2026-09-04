import { statusLabel } from '../lib/status.js';

/**
 * Switches which game the board is showing.
 *
 * The control sits on the game name rather than the team name, because the game
 * is the thing that changes: within one game a player has exactly one team
 * (0024), so a dropdown labelled with the team would promise a team switch it
 * cannot perform. Team names also repeat across games, which would leave two
 * options reading identically. The team follows as a consequence, printed by
 * the caller alongside this.
 *
 * With one game there is no choice to offer, so it renders as the plain title
 * it has always been -- no select, no chrome.
 */
export default function GamePicker({ games, gameId, onPick, fallbackName }) {
  if (games.length <= 1) {
    return <strong>{games[0]?.gameName ?? fallbackName}</strong>;
  }

  return (
    <select
      className="game-pick"
      value={gameId ?? ''}
      aria-label="Which game to show"
      onChange={(e) => onPick(e.target.value)}
    >
      {games.map((g) => (
        <option key={g.gameId} value={g.gameId}>
          {g.gameName} — {g.teamName} · {statusLabel(g.status)}
        </option>
      ))}
    </select>
  );
}

/**
 * Evidence-review harness. `npm run preview:evidence --prefix web`.
 *
 * Renders the real EvidenceReview against stubbed data so the revoke flow can
 * be looked at without a database. See stub-supabase.js for what is fake: the
 * two RPCs, and nothing else. The component, the confirm dialog, the
 * consequence sentences and the stylesheet are the shipping ones.
 */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import EvidenceReview from '../components/EvidenceReview.jsx';
import { resetDemo } from './stub-supabase.js';
import '../styles.css';

function Harness() {
  const [run, setRun] = useState(0);

  return (
    <div className="wrap" style={{ maxWidth: '54rem', margin: '0 auto', padding: '1.5rem' }}>
      <h1 style={{ marginBottom: '.25rem' }}>Evidence</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Harness — no database. Each row previews a different outcome: 1 in
        progress, 2 still complete without it, 3 un-fires a miss, 4 un-fires a
        hit, 5 refloats a ship, 6 reopens a
        won game.
      </p>
      <p>
        <button
          className="ghost"
          onClick={() => { resetDemo(); setRun((n) => n + 1); }}
        >
          Reset the six rows
        </button>
      </p>
      <EvidenceReview key={run} gameId="demo-game" />
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Harness />
  </StrictMode>
);

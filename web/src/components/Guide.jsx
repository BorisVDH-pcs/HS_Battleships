import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

/**
 * The player-facing "How to Play" guide: a welcome screen, a spotlighted
 * step-by-step tour of the real UI, a quick-reference version of the same
 * steps for browsing later, and an empty Q&A section for event-specific
 * questions to be filled in by whoever runs the event.
 *
 * Modelled on hs-bingo's guide.js/guide modal, adapted to React: state lives
 * in this one component instead of a handful of global functions, and the
 * "which board tab is showing" concern is handed back to App via `onTabNeed`
 * rather than reached for directly, since App already owns that state.
 */

const SEEN_KEY = 'hs-battleships:guide-seen';

// Fill these in with the event's own frequently-asked questions. Left empty
// on purpose — this is the "leave the Q&A section" part of the guide.
const QA_ITEMS = [
  // { q: 'What counts as valid proof for a tile?', a: '…' },
];

const TOUR_STEPS = [
  {
    targetId: 'app-header',
    title: '🎯 Battleships, Played on a Task Grid',
    body: 'Two teams, each with a hidden 10×10 fleet. The enemy grid is also a '
      + '100-tile task board — every tile hides both an OSRS task <em>and</em> a '
      + 'square of the enemy\'s ships.<br><br>'
      + 'There is <strong>no turn order</strong>. Your team plays whenever it has a '
      + 'free slot — claim a tile, complete its task, and the shot resolves the '
      + 'moment you do.',
  },
  {
    targetId: 'fleet-placer-section',
    title: '⚓ Placing Your Fleet',
    body: 'Before the game starts, your <strong>captain</strong> places your team\'s fleet — '
      + 'ships of size <strong>2, 3, 3, 4, 5</strong> — on your own board.<br><br>'
      + 'Pick a hull, click its top-left cell, press <strong>R</strong> to rotate. '
      + '<strong>Ships may not touch, not even at the corners</strong> — every ship needs '
      + 'at least one clear cell around it.<br><br>'
      + 'Fleets <strong>freeze the moment the game starts</strong> — for players, captains '
      + 'and admins alike.',
  },
  {
    targetId: 'enemy-board-section',
    title: '🌊 Enemy Waters — Claiming a Tile',
    body: 'This is the enemy\'s 100-tile grid, labelled <strong>A1..J10</strong>. Every tile\'s '
      + 'task is hidden until your team claims it — picking is blind, there is no '
      + 'question to weigh first.<br><br>'
      + 'Click any unclaimed tile to <strong>lock it in</strong>. That reveals the task to your '
      + 'team only, and takes one of your active slots.',
  },
  {
    targetId: 'active-tiles-section',
    title: '🗂️ Active Tiles — Your Slots',
    body: 'A team can hold at most a set number of claimed tiles at once (currently '
      + '<strong>three</strong>). No new tile can be claimed until one of the current ones '
      + 'is fired.<br><br>'
      + 'Each card shows the task for a tile you have locked in. An empty slot '
      + 'means you are free to claim another tile on the enemy board.',
  },
  {
    targetId: 'active-tiles-section',
    title: '📸 Firing — Submit Proof to Shoot',
    body: 'Complete the tile\'s in-game task, then attach a screenshot — drop a file, '
      + 'paste from your clipboard, or choose one from disk.<br><br>'
      + 'Click anywhere on a tile\'s card to <strong>select it</strong> (it lights up) — '
      + 'that is where the next <strong>Ctrl+V</strong> lands, so this matters when you '
      + 'have more than one active tile.<br><br>'
      + 'The submission that meets the required count <strong>is</strong> the shot: '
      + 'there is no separate "mark complete" button. HIT or MISS resolves immediately '
      + 'against the enemy\'s hidden placement, and the slot frees up.',
  },
  {
    targetId: 'active-tiles-section',
    title: '⚡ Early Completion',
    body: 'Some tiles list a worst-case count of submissions but also have a shorter '
      + 'route to finishing — a bigger drop, a faster method, whatever the task allows.<br><br>'
      + 'If a tile supports this, a <strong>Complete Early</strong> button appears once you\'ve '
      + 'attached at least one piece of evidence. Only use it once you have genuinely '
      + 'finished the task — the organiser reviews every submission.',
  },
  {
    targetId: 'fleet-board-section',
    tab: 'fleet',
    title: '🛡️ Your Fleet — Taking the Damage',
    body: 'Switch to the <strong>Your fleet</strong> tab to see your own board: where your '
      + 'ships sit, and where the enemy has fired back.<br><br>'
      + 'A hit here is <strong>damage</strong>, always shown in red. Once every cell of a ship '
      + 'has been hit it goes dark — the ship, not just the square, is gone. When every '
      + 'ship on a team\'s board is sunk, that team loses.',
  },
  {
    targetId: 'pet-jar-section',
    title: '🐾 Pet / Jar — Preview a Tile',
    body: 'Got a pet or jar drop that is not tied to any tile? Submit a screenshot of it '
      + 'here to earn a <strong>preview charge</strong>.<br><br>'
      + 'Spend a charge on any tile you have not yet claimed to see its <strong>task and '
      + 'artwork</strong> ahead of time — without revealing whether it hides a ship. '
      + 'Scouting ahead costs a charge either way.',
  },
  {
    targetId: 'event-feed-section',
    title: '📰 Activity Feed',
    body: 'A live log of everything happening in the game — claims, shots, sinks, and '
      + 'more.<br><br>'
      + 'Each line is tagged <strong>[GLOBAL]</strong> or <strong>[TEAM]</strong>. Global events '
      + '(a shot, a sunk ship, the game ending) are visible to both teams. Team-tagged '
      + 'events — like evidence being submitted — are only ever shown to your own team.',
  },
  {
    targetId: 'stats-panel-section',
    title: '📊 Stats',
    body: 'Live numbers for both teams: shots fired, hits, misses, accuracy, tiles '
      + 'claimed, and ships sunk. Click <strong>edit</strong> to choose which rows show.<br><br>'
      + '<strong>Every hit is worth exactly one point</strong> — so the Hits row doubles as the '
      + 'score. Nothing else on this panel affects the outcome; it is here to help you '
      + 'read the game, not to keep score in a second place.',
  },
  {
    targetId: 'app-header',
    title: '🏆 Winning',
    body: 'The game ends the moment one team\'s entire fleet — all five ships — has '
      + 'been sunk. The other team wins.<br><br>'
      + 'You now know everything there is to know. Jump into enemy waters, or open the '
      + '<strong>Quick Reference</strong> any time you need a reminder.',
  },
];

const Guide = forwardRef(function Guide({ autoShow, onTabNeed }, ref) {
  // 'closed' | 'welcome' | 'tour' | 'reference' | 'qa' | 'spotlight'
  const [phase, setPhase] = useState('closed');
  const [step, setStep] = useState(0);
  const [returnPhase, setReturnPhase] = useState('reference');
  const spotlightTimer = useRef(null);
  const autoShown = useRef(false);

  useImperativeHandle(ref, () => ({
    openWelcome: () => setPhase('welcome'),
    openReference: () => setPhase('reference'),
    openQa: () => setPhase('qa'),
  }));

  useEffect(() => {
    if (!autoShow || autoShown.current) return;
    autoShown.current = true;
    if (!localStorage.getItem(SEEN_KEY)) setPhase('welcome');
  }, [autoShow]);

  useEffect(() => () => clearTimeout(spotlightTimer.current), []);

  // Position the spotlight ring around the current step's target, and switch
  // the board tab if this step needs one. Re-runs on resize/scroll while a
  // spotlight is showing, since the board reflows at narrower widths.
  useEffect(() => {
    const showingTour = phase === 'tour' && step < TOUR_STEPS.length;
    if (!showingTour) return;
    const target = TOUR_STEPS[step];
    if (target.tab) onTabNeed?.(target.tab);

    function place() {
      const el = document.getElementById(target.targetId);
      const ring = document.getElementById('guide-spotlight-ring');
      if (!el || !ring) { if (ring) ring.style.display = 'none'; return; }
      const rect = el.getBoundingClientRect();
      const pad = 6;
      ring.style.display = 'block';
      ring.style.top = `${rect.top - pad}px`;
      ring.style.left = `${rect.left - pad}px`;
      ring.style.width = `${rect.width + pad * 2}px`;
      ring.style.height = `${rect.height + pad * 2}px`;
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // Double rAF: one for the tab switch to commit, one for layout to settle.
    const raf = requestAnimationFrame(() => requestAnimationFrame(place));
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [phase, step, onTabNeed]);

  function clearSpotlightRing() {
    const ring = document.getElementById('guide-spotlight-ring');
    if (ring) ring.style.display = 'none';
  }

  function startTour() {
    setStep(0);
    setPhase('tour');
  }

  function endTour() {
    clearSpotlightRing();
    setPhase('closed');
  }

  function next() {
    setStep((s) => Math.min(s + 1, TOUR_STEPS.length));
    if (step + 1 >= TOUR_STEPS.length) {
      localStorage.setItem(SEEN_KEY, '1');
      clearSpotlightRing();
    }
  }

  function prev() {
    setStep((s) => Math.max(s - 1, 0));
  }

  function spotlightFromReference(targetId, from) {
    setReturnPhase(from ?? 'reference');
    setPhase('spotlight');
    clearTimeout(spotlightTimer.current);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = document.getElementById(targetId);
      const ring = document.getElementById('guide-spotlight-ring');
      if (!el || !ring) return;
      const rect = el.getBoundingClientRect();
      const pad = 6;
      ring.style.display = 'block';
      ring.style.top = `${rect.top - pad}px`;
      ring.style.left = `${rect.left - pad}px`;
      ring.style.width = `${rect.width + pad * 2}px`;
      ring.style.height = `${rect.height + pad * 2}px`;
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }));
    spotlightTimer.current = setTimeout(() => resumeFromSpotlight(from), 8000);
  }

  function resumeFromSpotlight(from) {
    clearTimeout(spotlightTimer.current);
    clearSpotlightRing();
    setPhase(from ?? returnPhase);
  }

  if (phase === 'closed') {
    return <div id="guide-spotlight-ring" className="guide-spotlight-ring" style={{ display: 'none' }} />;
  }

  return (
    <>
      <div id="guide-spotlight-ring" className="guide-spotlight-ring" style={{ display: 'none' }} />

      {phase === 'spotlight' && (
        <button className="guide-back-btn" onClick={() => resumeFromSpotlight()}>
          ← Back to Guide
        </button>
      )}

      {phase === 'welcome' && (
        <div className="guide-backdrop" onClick={() => setPhase('closed')}>
          <div className="guide-welcome-card" onClick={(e) => e.stopPropagation()}>
            <div className="guide-welcome-icon">📖</div>
            <h2>How to Play</h2>
            <p className="muted">
              {localStorage.getItem(SEEN_KEY)
                ? 'Welcome back! Take the guided tour again or browse the quick reference.'
                : 'New here? The guided tour walks through every part of the app with '
                  + 'live highlights, so you always know exactly where to look.'}
            </p>
            <button onClick={startTour}>
              {localStorage.getItem(SEEN_KEY) ? '▶ Take the Tour Again' : '▶ Start Guided Tour'}
            </button>
            <div className="guide-or">— or —</div>
            <button className="ghost" onClick={() => setPhase('reference')}>Browse Quick Reference →</button>
            <button className="ghost" onClick={() => setPhase('qa')}>❓ Q&amp;A</button>
          </div>
        </div>
      )}

      {phase === 'tour' && (
        <div className="guide-tour-card">
          {step < TOUR_STEPS.length ? (
            <>
              <div className="guide-tour-header">
                <span className="guide-tour-badge">Step {step + 1} of {TOUR_STEPS.length}</span>
                <button className="guide-tour-close" onClick={endTour}>✕ End Tour</button>
              </div>
              <h3 dangerouslySetInnerHTML={{ __html: TOUR_STEPS[step].title }} />
              <div className="guide-tour-body" dangerouslySetInnerHTML={{ __html: TOUR_STEPS[step].body }} />
              <div className="guide-tour-progress">
                {TOUR_STEPS.map((_, i) => (
                  <span key={i} className={`guide-dot${i === step ? ' on' : ''}`} />
                ))}
              </div>
              <div className="guide-tour-actions">
                <button className="ghost" onClick={prev} disabled={step === 0}>← Back</button>
                <button onClick={next}>{step === TOUR_STEPS.length - 1 ? 'Finish ✓' : 'Next →'}</button>
              </div>
              <button className="link guide-tour-skip" onClick={() => setPhase('reference')}>
                Skip to Quick Reference →
              </button>
            </>
          ) : (
            <>
              <div className="guide-tour-header">
                <span className="guide-tour-badge">Tour Complete!</span>
              </div>
              <h3>🎉 You&rsquo;re Ready to Play</h3>
              <p>You now know every part of the app. Jump into the game, or open the Quick
                Reference any time you need a reminder about a specific feature.</p>
              <div className="guide-tour-actions">
                <button className="ghost" onClick={endTour}>⚓ Start Playing</button>
                <button onClick={() => setPhase('reference')}>Open Quick Reference</button>
              </div>
            </>
          )}
        </div>
      )}

      {phase === 'reference' && (
        <div className="guide-backdrop" onClick={() => setPhase('closed')}>
          <div className="guide-card" onClick={(e) => e.stopPropagation()}>
            <button className="guide-close-btn" onClick={() => setPhase('closed')}>✕</button>
            <div className="guide-header">
              <div className="guide-title">📖 How to Play</div>
              <div className="guide-subtitle">Battleships · Complete Guide</div>
            </div>

            <nav className="guide-nav">
              {TOUR_STEPS.map((s, i) => (
                <button
                  key={i}
                  className="guide-nav-btn"
                  onClick={() => document.getElementById(`guide-s${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                >
                  {i + 1}. {s.title.replace(/^[^\w]+/u, '')}
                </button>
              ))}
            </nav>

            <div className="guide-body">
              {TOUR_STEPS.map((s, i) => (
                <div className="guide-section" key={i} id={`guide-s${i}`}>
                  <div className="guide-step-header">
                    <div className="guide-step-num">{i + 1}</div>
                    <div className="guide-step-title" dangerouslySetInnerHTML={{ __html: s.title }} />
                  </div>
                  <div className="guide-step-body" dangerouslySetInnerHTML={{ __html: s.body }} />
                  <button
                    className="guide-spotlight-btn"
                    onClick={() => spotlightFromReference(s.targetId, 'reference')}
                  >
                    👁 Highlight in UI
                  </button>
                </div>
              ))}
            </div>

            <button className="ghost guide-qa-link" onClick={() => setPhase('qa')}>❓ Open Q&amp;A →</button>
          </div>
        </div>
      )}

      {phase === 'qa' && (
        <div className="guide-backdrop" onClick={() => setPhase('closed')}>
          <div className="guide-card qa-card" onClick={(e) => e.stopPropagation()}>
            <button className="guide-close-btn" onClick={() => setPhase('closed')}>✕</button>
            <div className="guide-header">
              <div className="guide-title">❓ Q&amp;A</div>
              <div className="guide-subtitle">Answers to questions specific to this event</div>
            </div>
            <div className="guide-body">
              {QA_ITEMS.length === 0 ? (
                <p className="muted">
                  No questions added yet — this section is left for the event organiser
                  to fill in with whatever comes up (edge cases in a task's wording, how a
                  specific drop counts, etc).
                </p>
              ) : (
                QA_ITEMS.map((item, i) => (
                  <div className="qa-item" key={i}>
                    <div className="qa-q">{item.q}</div>
                    <div className="qa-a">{item.a}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
});

export default Guide;

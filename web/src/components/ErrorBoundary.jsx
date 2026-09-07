import { Component } from 'react';

/**
 * The last thing between a thrown render and a white page.
 *
 * React unmounts the whole tree when a render throws and nothing catches it.
 * On this app that means the board, the slots, the feed and the sign-out
 * button all disappear together, mid-event, on a phone — and a player has no
 * reason to think a reload would help, because nothing on screen suggests
 * anything happened. They report that the site is down, which is nearly true
 * for them and not true for anybody else.
 *
 * So the whole point of this is the reload button. The message underneath it
 * is for the organiser it gets read out to: a name and a line of text they can
 * paste into Discord is the difference between "it broke" and something that
 * can be looked up.
 *
 * A class, because `getDerivedStateFromError` has no hook equivalent — this is
 * the one thing in React that still requires one.
 *
 * Deliberately not a retry. Re-rendering the same tree with the same state
 * throws again, and a button that looks like it might help and never does is
 * worse than one that plainly reloads.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Kept: the stack is in the console for anyone who opens it, and the
    // fallback below deliberately shows only the message.
    console.error('[HS Battleships] render failed', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="app">
        <section className="card boundary">
          <h2>Something broke on this page</h2>
          <p>
            The game itself is fine — nothing you did was lost, and no shot or
            screenshot goes missing because of this. Reloading almost always
            fixes it.
          </p>
          <button onClick={() => window.location.reload()}>Reload the page</button>
          <p className="muted">
            If it keeps happening, send this line to an organiser:
          </p>
          <code className="boundary-detail">{String(error?.message ?? error)}</code>
        </section>
      </main>
    );
  }
}

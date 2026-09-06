import { useState } from 'react';
import { ICONS, searchIcons, iconLabel } from '../lib/icons.js';
import TileIcon from './TileIcon.jsx';

/**
 * Pick one of the icons in `public/icons`, by looking at them.
 *
 * The paste grammar names an icon by its slug, which means knowing the slug —
 * fine for a generated board, useless when the question is "which of these is
 * the right hilt". So this shows the artwork and searches the slug behind it;
 * `searchIcons` matches every word in any order, because nobody remembers
 * whether it is `blood_amulet` or `amulet_of_blood_fury`.
 *
 * Collapsed to the current choice until opened. A hundred-odd thumbnails is a
 * lot of page to leave standing behind a field the tile already has an answer for.
 */
export default function IconPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const matches = searchIcons(query);

  return (
    <div className="icon-picker">
      <button
        type="button"
        className="icon-picker-current"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {value
          ? <TileIcon slug={value} fallback={null} />
          : <span className="icon-picker-none" aria-hidden="true">?</span>}
        <span>{value ? iconLabel(value) : 'No icon'}</span>
        <span className="muted">{open ? 'Close' : 'Change'}</span>
      </button>

      {open && (
        <div className="icon-picker-body">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${ICONS.length} icons`}
            autoFocus
          />
          <div className="icon-grid">
            {/* Clearing the icon is a choice like any other, so it sits in the
                grid rather than off to one side as a stray "clear" link. */}
            <button
              type="button"
              className={`icon-choice${value ? '' : ' on'}`}
              onClick={() => { onChange(''); setOpen(false); }}
              title="No icon"
            >
              <span className="icon-picker-none" aria-hidden="true">?</span>
            </button>
            {matches.map((slug) => (
              <button
                key={slug}
                type="button"
                className={`icon-choice${slug === value ? ' on' : ''}`}
                onClick={() => { onChange(slug); setOpen(false); }}
                title={iconLabel(slug)}
              >
                <TileIcon slug={slug} fallback={null} />
              </button>
            ))}
          </div>
          {matches.length === 0 && (
            <p className="muted">
              Nothing matches “{query}”. Artwork is added to{' '}
              <code>web/public/icons</code> and listed by{' '}
              <code>npm run icons:manifest</code>.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

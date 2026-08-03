export type Tab = 'search' | 'topics' | 'today' | 'settings';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'search', label: 'Search' },
  { id: 'topics', label: 'Topics' },
  { id: 'today', label: 'Today' },
  { id: 'settings', label: 'Settings' },
];

/**
 * Four surfaces, Search first and default. Search is §1's primary surface —
 * "search is the feature that retains users" — and everything that used to
 * sit above it (wiring probes, stage timings, drop audits) is diagnostic
 * content nobody opens the extension to read; it now lives behind Settings ›
 * Diagnostics instead of ahead of the one thing people came here to do.
 */
export function Nav({ active, onChange }: { active: Tab; onChange: (tab: Tab) => void }): React.JSX.Element {
  return (
    <nav className="top-nav">
      <span className="top-nav-brand">Browser Intelligence</span>
      <ul className="top-nav-tabs">
        {TABS.map((tab) => (
          <li key={tab.id}>
            <button
              type="button"
              className={`top-nav-tab${tab.id === active ? ' top-nav-tab-active' : ''}`}
              aria-current={tab.id === active ? 'page' : undefined}
              onClick={() => onChange(tab.id)}
            >
              {tab.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

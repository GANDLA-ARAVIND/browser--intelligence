import { useState } from 'react';
import { Nav, type Tab } from './Nav.js';
import { Search } from './Search.js';
import { SettingsPage } from './SettingsPage.js';
import { TodayPage } from './TodayPage.js';
import { TopicsPage } from './TopicsPage.js';

/**
 * Four surfaces behind top-level navigation, Search first (§1: "search is the
 * feature that retains users; analytics is the feature that impresses on
 * install — when they conflict, search wins").
 *
 * This replaces a single scrolling page that put wiring probes, stage
 * timings, stall tables and a filter-drop audit ahead of the one thing
 * someone opens this extension to do. Nothing from that page was deleted —
 * every panel still exists, moved into Settings › Diagnostics (`Diagnostics`)
 * or onto its own tab (`SettingsPage`, `TopicsPage`, `TodayPage`).
 */
export function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('search');

  return (
    <>
      <Nav active={tab} onChange={setTab} />
      <main className={tab === 'search' ? 'main-search' : undefined}>
        {tab === 'search' && <Search />}
        {tab === 'topics' && <TopicsPage />}
        {tab === 'today' && <TodayPage />}
        {tab === 'settings' && <SettingsPage />}
      </main>
    </>
  );
}

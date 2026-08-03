import { useEffect, useState } from 'react';
import { FirstRun } from './FirstRun.js';
import { Nav, type Tab } from './Nav.js';
import { Search } from './Search.js';
import { SettingsPage } from './SettingsPage.js';
import { TodayPage } from './TodayPage.js';
import { TopicsPage } from './TopicsPage.js';
import { getMeta, openDatabase, type BackfillSummary, type OnboardingState } from '../lib/storage.js';

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
/**
 * A genuine fresh install (`onInstalled` reason `'install'`, never `'update'`
 * or a developer reload) writes an `OnboardingState` marker before starting
 * its automatic backfill. Its presence *combined with* no `BackfillSummary`
 * yet is the first-run signal — not a separate flag that could drift from
 * whether a backfill has actually completed. Once a summary exists (this run
 * finished, or a later one did), first-run never shows again; the manual
 * button in Settings is the only re-run path from then on (§10, §14).
 */
type FirstRunState = 'checking' | 'active' | 'done';

export function App(): React.JSX.Element | null {
  const [tab, setTab] = useState<Tab>('search');
  const [firstRun, setFirstRun] = useState<FirstRunState>('checking');

  useEffect(() => {
    void (async () => {
      try {
        const db = await openDatabase();
        const onboarding = await getMeta<OnboardingState>(db, 'onboarding');
        const summary = await getMeta<BackfillSummary>(db, 'backfill');
        setFirstRun(onboarding !== null && summary === null ? 'active' : 'done');
      } catch {
        setFirstRun('done');
      }
    })();
  }, []);

  // Nothing to paint yet either way — deciding takes one IndexedDB read, not
  // long enough to justify a loading skeleton of its own.
  if (firstRun === 'checking') return null;

  if (firstRun === 'active') {
    return <FirstRun onComplete={() => setFirstRun('done')} />;
  }

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

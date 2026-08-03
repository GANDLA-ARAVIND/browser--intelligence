import { Backfill } from './Backfill.js';
import { DataSettings } from './DataSettings.js';
import { Diagnostics } from './Diagnostics.js';
import { PrivacySettings } from './PrivacySettings.js';
import { RemovePages } from './RemovePages.js';

/**
 * Backfill, what's excluded, retroactive removal, export and bulk delete —
 * the controls someone actually needs, in the order they'd reach for them.
 * Diagnostics sits collapsed at the end: useful, not something most visits
 * to Settings are about.
 */
export function SettingsPage(): React.JSX.Element {
  return (
    <>
      <Backfill />
      <PrivacySettings />
      <RemovePages />
      <DataSettings />
      <Diagnostics />
    </>
  );
}

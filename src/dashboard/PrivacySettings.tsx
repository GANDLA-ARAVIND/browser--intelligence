import { useCallback, useEffect, useState } from 'react';
import { CATEGORY_LABELS, SENSITIVE_CATEGORIES, type SensitiveCategory } from '../lib/blocklist.js';
import { loadSettings, setCategoryBlocked } from '../platform/settings.js';

/**
 * §9's blocklist, as a user preference rather than a constant.
 *
 * Every category ships blocked, because the cost is asymmetric — a missed
 * banking domain leaks, an unwanted block only loses a page. But which
 * categories are actually sensitive is the user's judgement: someone
 * researching visa paperwork wants their passport pages indexed, and that is a
 * real topic in their life rather than a secret.
 */
export function PrivacySettings(): React.JSX.Element {
  const [blocked, setBlocked] = useState<SensitiveCategory[] | null>(null);
  const [pending, setPending] = useState<SensitiveCategory | null>(null);

  useEffect(() => {
    void loadSettings().then((settings) => setBlocked(settings.blockedCategories));
  }, []);

  const toggle = useCallback(async (category: SensitiveCategory, next: boolean) => {
    setPending(category);
    const settings = await setCategoryBlocked(category, next);
    setBlocked(settings.blockedCategories);
    setPending(null);
  }, []);

  return (
    <section className="panel">
      <h2>What is excluded</h2>
      <p className="detail settings-intro">
        These categories are never read or embedded. Changes apply to the next
        backfill; pages already stored are not removed.
      </p>

      <ul className="settings-list">
        {SENSITIVE_CATEGORIES.map((category) => {
          const isBlocked = blocked?.includes(category) ?? true;
          return (
            <li key={category}>
              <label>
                <input
                  type="checkbox"
                  checked={isBlocked}
                  disabled={blocked === null || pending === category}
                  onChange={(event) => void toggle(category, event.target.checked)}
                />
                <span>
                  <strong>{CATEGORY_LABELS[category].label}</strong>
                  <span className="detail"> — {CATEGORY_LABELS[category].description}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

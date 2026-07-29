/**
 * User settings, behind src/platform because `chrome.storage` is a browser API
 * (CLAUDE.md §2.6).
 *
 * `chrome.storage.local`, not `.sync`: settings describe what may be indexed on
 * *this* machine, and §9's answer to a shared computer is a separate Chrome
 * profile. Syncing a privacy preference to other devices is the wrong default.
 */

import { DEFAULT_BLOCKED_CATEGORIES, SENSITIVE_CATEGORIES, type SensitiveCategory } from '../lib/blocklist.js';

const KEY = 'settings';

export interface Settings {
  /** §9 categories currently excluded from capture. */
  blockedCategories: SensitiveCategory[];
}

export function defaultSettings(): Settings {
  return { blockedCategories: [...DEFAULT_BLOCKED_CATEGORIES] };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  const raw: unknown = stored[KEY];

  if (typeof raw !== 'object' || raw === null) return defaultSettings();
  const candidate = (raw as Record<string, unknown>)['blockedCategories'];
  if (!Array.isArray(candidate)) return defaultSettings();

  // Filter to known categories: a category renamed in a later version would
  // otherwise persist as a dead string and silently block nothing.
  const blockedCategories = candidate.filter((value): value is SensitiveCategory =>
    SENSITIVE_CATEGORIES.includes(value as SensitiveCategory)
  );
  return { blockedCategories };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings });
}

export async function setCategoryBlocked(category: SensitiveCategory, blocked: boolean): Promise<Settings> {
  const settings = await loadSettings();
  const next = new Set(settings.blockedCategories);
  if (blocked) next.add(category);
  else next.delete(category);

  // Preserve the canonical order so the stored value is stable.
  const updated: Settings = { blockedCategories: SENSITIVE_CATEGORIES.filter((c) => next.has(c)) };
  await saveSettings(updated);
  return updated;
}

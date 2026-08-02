/**
 * Export formatting (CLAUDE.md §9: "Export as JSON and Markdown"). Pure —
 * takes records, returns strings. Triggering the download is the dashboard's
 * job, same split as everywhere else in src/lib.
 */

import { dayStart } from './day.js';
import type { PageRecord } from './storage.js';

/**
 * The stored `vector` and `extractionQuality` are left out deliberately: a raw
 * embedding is meaningless without the model that produced it, and the
 * quality score is an internal diagnostic, not something the export exists to
 * surface. Everything a user would recognise as "what I read" is kept.
 */
export interface ExportedPage {
  url: string;
  title: string;
  text: string;
  format: string;
  topics: string[];
  firstVisit: string;
  lastVisit: string;
  visitCount: number;
  activeSeconds: number;
}

function toExportedPage(page: PageRecord): ExportedPage {
  return {
    url: page.url,
    title: page.title,
    text: page.text,
    format: page.format,
    topics: page.topics,
    firstVisit: new Date(page.firstVisit).toISOString(),
    lastVisit: new Date(page.lastVisit).toISOString(),
    visitCount: page.visitCount,
    activeSeconds: page.activeSeconds,
  };
}

export function toExportJson(pages: PageRecord[]): string {
  const sorted = [...pages].sort((a, b) => b.lastVisit - a.lastVisit);
  return JSON.stringify(sorted.map(toExportedPage), null, 2);
}

function activeSecondsLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

/**
 * Grouped by day, §7's day boundary (04:00) rather than midnight — a page
 * read at 1am belongs with the previous day's heading, matching how the
 * dashboard will eventually roll up sessions.
 */
export function toExportMarkdown(pages: PageRecord[]): string {
  const sorted = [...pages].sort((a, b) => b.lastVisit - a.lastVisit);
  const lines: string[] = ['# Browser Intelligence export', ''];

  let currentDay: number | null = null;
  for (const page of sorted) {
    const day = dayStart(page.lastVisit);
    if (day !== currentDay) {
      currentDay = day;
      lines.push(`## ${new Date(day).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`, '');
    }

    const meta = [
      page.format,
      page.visitCount > 1 ? `${page.visitCount}×` : null,
      page.activeSeconds > 0 ? activeSecondsLabel(page.activeSeconds) : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' · ');

    lines.push(`- [${page.title || page.url}](${page.url})${meta.length > 0 ? ` — ${meta}` : ''}`);
  }

  return lines.join('\n') + '\n';
}

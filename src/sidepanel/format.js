// Date and time display for the side panel, in the UI language (pure module, Node-testable).
import { formatDate, getLocale } from '../lib/i18n.js';

const DAY_MS = 86400000;

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole calendar days between `ts` and `now` (0 = today, 1 = yesterday …; negative = future). */
export function daysAgo(ts, now = Date.now()) {
  return Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);
}

/** History group of a timestamp: 'today' | 'yesterday' | 'week' | 'older'. */
export function dateGroup(ts, now = Date.now()) {
  const days = daysAgo(ts, now);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return 'week';
  return 'older';
}

/** Time of day for today's timestamps, otherwise the short date. */
export function shortTime(ts, now = Date.now()) {
  if (daysAgo(ts, now) === 0) return formatDate(ts, { hour: '2-digit', minute: '2-digit' });
  return formatDate(ts, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Full date and time (tooltips, exports). */
export function fullDateTime(ts) {
  return formatDate(ts, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Compact "when" for lists: the time today, a relative day within the last week
 * ("yesterday", "3 days ago" in the UI language), the date before that.
 */
export function relativeDay(ts, now = Date.now()) {
  const days = daysAgo(ts, now);
  if (days <= 0 || days >= 7) return shortTime(ts, now);
  try {
    return new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' }).format(-days, 'day');
  } catch {
    return shortTime(ts, now);
  }
}

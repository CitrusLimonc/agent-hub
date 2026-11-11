import type { ConversationSummary } from '../core/types';

/** Newest pin first; ordinary conversations follow by latest activity.
 * Pins ignore the age cutoff so they never disappear after a quiet week. */
export function compareConversations(a: ConversationSummary, b: ConversationSummary): number {
  if (!!a.pinnedAt !== !!b.pinnedAt) return a.pinnedAt ? -1 : 1;
  if (a.pinnedAt && b.pinnedAt && a.pinnedAt !== b.pinnedAt) return b.pinnedAt - a.pinnedAt;
  return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
}

export function matchesConversationAge(c: ConversationSummary, cutoff: number): boolean {
  return !!c.pinnedAt || !cutoff || new Date(c.lastActivityAt).getTime() >= cutoff;
}

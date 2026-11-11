const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareConversations, matchesConversationAge } = require('../dist-electron/src/shared/conversationOrder');

test('pins stay ahead of more active conversations and ignore the date cutoff', () => {
  const oldPin = { sessionId: 'old', pinnedAt: 10, lastActivityAt: '2020-01-01' };
  const newPin = { sessionId: 'new', pinnedAt: 20, lastActivityAt: '2021-01-01' };
  const recent = { sessionId: 'recent', lastActivityAt: '2026-10-30' };
  const older = { sessionId: 'older', lastActivityAt: '2026-10-29' };
  const list = [older, oldPin, recent, newPin].sort(compareConversations);
  assert.deepEqual(list.map((c) => c.sessionId), ['new', 'old', 'recent', 'older']);
  assert.ok(matchesConversationAge(oldPin, Date.parse('2026-10-25')));
  assert.ok(!matchesConversationAge({ ...oldPin, pinnedAt: null }, Date.parse('2026-10-25')));
  assert.deepEqual([{ ...oldPin, pinnedAt: null }, recent].sort(compareConversations).map((c) => c.sessionId), ['recent', 'old']);
});

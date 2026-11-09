import { it, expect } from 'vitest';
import { normalizeReviews } from '../../src/adapters/feedback';
import { emptyLedger } from '../../src/domain/contracts';
import { reduce } from '../../src/domain/engine';
import { localPolicy } from '../../src/policy';
it('reuses original input/reply/context/trace and retains distinct feedback revisions', () => {
  const review = {
    traceId: 'tr_' + 'a'.repeat(32),
    requestId: 'request',
    createdAt: '2030-01-07T02:00:00Z',
    updatedAt: '2030-01-07T02:00:00Z',
    inputText: '转三圈',
    replyText: '好',
    qualityStatus: 'unacceptable',
    reasonNote: '次数不符',
    actionClipIds: ['clip-a'],
    contentSegments: [{ part: 1 }, { part: 2 }],
    interactionSummary: { context: 'synthetic' },
  };
  const first = normalizeReviews({ items: [review], nextCursor: 'next-page', limit: 50 }, 'p', 'feedback');
  expect(first.next_cursor).toBe('next-page');
  const second = normalizeReviews(
    {
      items: [{ ...review, updatedAt: '2030-01-07T03:00:00Z', reasonNote: '补充输入' }],
      nextCursor: null,
      limit: 50,
    },
    'p',
    'feedback',
  );
  let s = emptyLedger('p');
  const p = localPolicy('p');
  for (const e of [first.events[0], first.events[0], second.events[0]]) s = reduce(s, e, p);
  expect(Object.keys(s.cases)).toHaveLength(1);
  expect(Object.values(s.cases)[0].observations).toHaveLength(2);
  expect(first.events[0].payload.content_segments).toHaveLength(2);
  expect(first.events[0].payload.version_refs).toEqual({});
});

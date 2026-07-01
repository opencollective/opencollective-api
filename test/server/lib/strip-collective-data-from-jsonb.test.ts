import { expect } from 'chai';

import {
  cleanupActivityDataJsonb,
  cleanupCollectiveDataJsonb,
  stripDataKey,
} from '../../../server/lib/cleanup/strip-collective-data-from-jsonb';

describe('server/lib/cleanup/strip-collective-data-from-jsonb', () => {
  describe('stripDataKey', () => {
    it('removes the data key from an object', () => {
      expect(stripDataKey({ id: 1, slug: 'test', data: { nested: true } })).to.deep.eq({ id: 1, slug: 'test' });
    });
  });

  describe('cleanupCollectiveDataJsonb', () => {
    it('flattens nested data chains and slims spamReport.data', () => {
      const bloated = {
        isTrustedHost: true,
        data: {
          data: {
            policies: { REQUIRE_2FA_FOR_ADMINS: true },
          },
          policies: { EXPENSE_PUBLIC_VENDORS: false },
        },
        spamReport: {
          score: 0.1,
          data: {
            id: 1,
            slug: 'test',
            type: 'COLLECTIVE',
            name: 'Test',
            settings: { features: {} },
            data: { nested: true },
          },
        },
      };

      expect(cleanupCollectiveDataJsonb(bloated)).to.deep.eq({
        isTrustedHost: true,
        policies: { REQUIRE_2FA_FOR_ADMINS: true, EXPENSE_PUBLIC_VENDORS: false },
        spamReport: {
          score: 0.1,
          data: {
            id: 1,
            slug: 'test',
            type: 'COLLECTIVE',
            name: 'Test',
          },
        },
      });
    });
  });

  describe('cleanupActivityDataJsonb', () => {
    it('strips data from collective snapshots and edit diffs', () => {
      const bloated = {
        collective: { id: 1, slug: 'test', data: { members: 'a,b' } },
        previousData: { tags: ['old'], data: { privateInstructions: 'secret' } },
        newData: { tags: ['new'], data: { privateInstructions: 'secret2' } },
      };

      expect(cleanupActivityDataJsonb(bloated)).to.deep.eq({
        collective: { id: 1, slug: 'test' },
        previousData: { tags: ['old'] },
        newData: { tags: ['new'] },
      });
    });
  });
});

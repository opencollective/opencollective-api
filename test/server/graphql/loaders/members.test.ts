import { expect } from 'chai';
import moment from 'moment';

import { roles } from '../../../../server/constants';
import { TransactionKind } from '../../../../server/constants/transaction-kind';
import { generateMemberIsActiveLoader } from '../../../../server/graphql/loaders/members';
import { fakeCollective, fakeMember, fakeOrder, fakeTier, fakeTransaction } from '../../../test-helpers/fake-data';
import { makeRequest } from '../../../utils';

describe('server/graphql/loaders/members', () => {
  describe('generateMemberIsActiveLoader', () => {
    let memberWithoutTier,
      memberWithFlexibleTier,
      memberWithMonthlyTierActive,
      memberWithMonthlyTierInactive,
      memberWithYearlyTierActive,
      memberWithYearlyTierInactive;

    const fakeContribution = async (collective, FromCollectiveId, TierId, lastTransactionDate) => {
      const order = await fakeOrder({
        FromCollectiveId,
        CollectiveId: collective.id,
        TierId,
      });
      await fakeTransaction(
        {
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          HostCollectiveId: collective.HostCollectiveId,
          FromCollectiveId,
          amount: 1000,
          type: 'CREDIT',
          OrderId: order.id,
          createdAt: lastTransactionDate,
        },
        { createDoubleEntry: true },
      );
    };

    before(async () => {
      const collective = await fakeCollective();

      // Member without tier
      memberWithoutTier = await fakeMember({ CollectiveId: collective.id, TierId: null, role: roles.BACKER });

      // Member with flexible tier
      const flexibleTier = await fakeTier({
        CollectiveId: collective.id,
        interval: 'flexible',
        amountType: 'FLEXIBLE',
      });
      memberWithFlexibleTier = await fakeMember({
        CollectiveId: collective.id,
        TierId: flexibleTier.id,
        role: roles.BACKER,
      });

      // Monthly tiers
      const monthlyTier = await fakeTier({ CollectiveId: collective.id, interval: 'month' });

      memberWithMonthlyTierActive = await fakeMember({
        CollectiveId: collective.id,
        TierId: monthlyTier.id,
        role: roles.BACKER,
      });
      const twoDaysAgo = moment().subtract(2, 'days').toDate();
      await fakeContribution(collective, memberWithMonthlyTierActive.MemberCollectiveId, monthlyTier.id, twoDaysAgo);

      memberWithMonthlyTierInactive = await fakeMember({
        CollectiveId: collective.id,
        TierId: monthlyTier.id,
        role: roles.BACKER,
      });
      const twoMonthsAgo = moment().subtract(2, 'months').toDate();
      await fakeContribution(
        collective,
        memberWithMonthlyTierInactive.MemberCollectiveId,
        monthlyTier.id,
        twoMonthsAgo,
      );

      // Yearly tiers
      const yearlyTier = await fakeTier({ CollectiveId: collective.id, interval: 'year' });

      memberWithYearlyTierActive = await fakeMember({
        CollectiveId: collective.id,
        TierId: yearlyTier.id,
        role: roles.BACKER,
      });
      const oneMonthAgo = moment().subtract(1, 'months').toDate();
      await fakeContribution(collective, memberWithYearlyTierActive.MemberCollectiveId, yearlyTier.id, oneMonthAgo);

      memberWithYearlyTierInactive = await fakeMember({
        CollectiveId: collective.id,
        TierId: yearlyTier.id,
        role: roles.BACKER,
      });
      const aYearAndAHalfAgo = moment().subtract(15, 'months').toDate();
      await fakeContribution(
        collective,
        memberWithYearlyTierInactive.MemberCollectiveId,
        yearlyTier.id,
        aYearAndAHalfAgo,
      );
    });

    it('returns the right values for inactive members', async () => {
      const req = makeRequest() as unknown as Express.Request;
      const inactive = await generateMemberIsActiveLoader(req).loadMany([
        memberWithMonthlyTierInactive.id,
        memberWithYearlyTierInactive.id,
      ]);

      expect({
        memberWithMonthlyTierInactive: inactive[0],
        memberWithYearlyTierInactive: inactive[1],
      }).to.deep.equal({
        memberWithMonthlyTierInactive: false,
        memberWithYearlyTierInactive: false,
      });
    });

    it('returns the right values for active members', async () => {
      const req = makeRequest() as unknown as Express.Request;
      const active = await generateMemberIsActiveLoader(req).loadMany([
        memberWithMonthlyTierActive.id,
        memberWithYearlyTierActive.id,
        memberWithoutTier.id,
        memberWithFlexibleTier.id,
      ]);

      expect({
        memberWithMonthlyTierActive: active[0],
        memberWithYearlyTierActive: active[1],
        memberWithoutTier: active[2],
        memberWithFlexibleTier: active[3],
      }).to.deep.equal({
        memberWithMonthlyTierActive: true,
        memberWithYearlyTierActive: true,
        memberWithoutTier: true,
        memberWithFlexibleTier: true,
      });
    });
  });
});

import { expect } from 'chai';
import gql from 'fake-tag';

import { PayoutMethodTypes } from '../../../../../server/models/PayoutMethod';
import { fakeExpense, fakePayoutMethod, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

describe('server/graphql/v2/object/PayoutMethod', () => {
  before(resetTestDB);

  describe('canBeDeleted', () => {
    it('returns true for payment methods that can be deleted or archived', async () => {
      const user = await fakeUser();
      await fakePayoutMethod({
        type: PayoutMethodTypes.STRIPE,
        name: 'cannotBeDeleted - is stripe pm',
        CollectiveId: user.CollectiveId,
      });

      const pm = await fakePayoutMethod({
        type: PayoutMethodTypes.BANK_ACCOUNT,
        name: 'canBeArchived - is used in expenses',
        CollectiveId: user.CollectiveId,
      });
      await fakeExpense({
        PayoutMethodId: pm.id,
        FromCollectiveId: user.CollectiveId,
      });

      await fakePayoutMethod({
        type: PayoutMethodTypes.BANK_ACCOUNT,
        name: 'canBeDeleted',
        CollectiveId: user.CollectiveId,
      });

      const result = await graphqlQueryV2(
        gql`
          query Account($slug: String!) {
            account(slug: $slug) {
              id
              payoutMethods {
                id
                name
                type
                canBeDeleted
              }
            }
          }
        `,
        { slug: user.collective.slug },
        user,
      );
      expect(result.errors).to.not.exist;
      const pms = result.data.account.payoutMethods;
      for (const pm of pms) {
        if (pm.name.includes('canBeDeleted') || pm.name.includes('canBeArchived')) {
          expect(pm.canBeDeleted).to.be.true;
        } else {
          expect(pm.canBeDeleted, JSON.stringify(pm)).to.be.false;
        }
      }
    });
  });

  describe('canBeEdited', () => {
    it('returns true for payment methods that can be edited or archived', async () => {
      const user = await fakeUser();
      await fakePayoutMethod({
        type: PayoutMethodTypes.STRIPE,
        name: 'cannotBeEdited - is stripe pm',
        CollectiveId: user.CollectiveId,
      });

      const pm = await fakePayoutMethod({
        type: PayoutMethodTypes.BANK_ACCOUNT,
        name: 'canBeArchived - is used in expenses',
        CollectiveId: user.CollectiveId,
      });
      await fakeExpense({
        PayoutMethodId: pm.id,
        FromCollectiveId: user.CollectiveId,
      });

      await fakePayoutMethod({
        type: PayoutMethodTypes.BANK_ACCOUNT,
        name: 'canBeEdited',
        CollectiveId: user.CollectiveId,
      });

      const result = await graphqlQueryV2(
        gql`
          query Account($slug: String!) {
            account(slug: $slug) {
              id
              payoutMethods {
                id
                name
                type
                canBeEdited
              }
            }
          }
        `,
        { slug: user.collective.slug },
        user,
      );
      expect(result.errors).to.not.exist;
      const pms = result.data.account.payoutMethods;
      for (const pm of pms) {
        if (pm.name.includes('canBeEdited') || pm.name.includes('canBeArchived')) {
          expect(pm.canBeEdited).to.be.true;
        } else {
          expect(pm.canBeEdited, JSON.stringify(pm)).to.be.false;
        }
      }
    });
  });

  describe('canBeArchived', () => {
    it('returns true for payment methods that can be archived', async () => {
      const user = await fakeUser();
      await fakePayoutMethod({
        type: PayoutMethodTypes.STRIPE,
        name: 'cannotBeArchived - is stripe pm',
        CollectiveId: user.CollectiveId,
      });

      await fakePayoutMethod({
        type: PayoutMethodTypes.BANK_ACCOUNT,
        name: 'canBeArchived',
        CollectiveId: user.CollectiveId,
      });

      const result = await graphqlQueryV2(
        gql`
          query Account($slug: String!) {
            account(slug: $slug) {
              id
              payoutMethods {
                id
                name
                type
                canBeArchived
              }
            }
          }
        `,
        { slug: user.collective.slug },
        user,
      );
      expect(result.errors).to.not.exist;
      const pms = result.data.account.payoutMethods;
      for (const pm of pms) {
        if (pm.name === 'canBeArchived') {
          expect(pm.canBeArchived).to.be.true;
        } else {
          expect(pm.canBeArchived, JSON.stringify(pm)).to.be.false;
        }
      }
    });
  });
});

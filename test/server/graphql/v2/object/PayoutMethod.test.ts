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
        if (pm.name.includes('canBeDeleted')) {
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

  describe('archived payout method obfuscation', () => {
    it('returns null for data when collective admin queries an archived payout method', async () => {
      const user = await fakeUser();
      const archivedPm = await fakePayoutMethod({
        type: PayoutMethodTypes.BANK_ACCOUNT,
        name: 'Secret Bank',
        CollectiveId: user.CollectiveId,
        isSaved: false,
        data: {
          accountHolderName: 'Secret Holder',
          currency: 'EUR',
          type: 'IBAN',
          details: { iban: 'FR123456789' },
        },
      });
      await fakeExpense({ PayoutMethodId: archivedPm.id, status: 'PAID' });

      const result = await graphqlQueryV2(
        gql`
          query Account($slug: String!) {
            account(slug: $slug) {
              id
              payoutMethods(includeArchived: true) {
                id
                name
                data
                isSaved
                type
              }
            }
          }
        `,
        { slug: user.collective.slug },
        user,
      );
      expect(result.errors).to.not.exist;
      const archivedFromQuery = result.data.account.payoutMethods.find(pm => pm.id && !pm.isSaved);
      expect(archivedFromQuery).to.exist;
      expect(archivedFromQuery.name).to.be.equal('Secret Bank');
      expect(archivedFromQuery.data).to.be.null;
      expect(archivedFromQuery.isSaved).to.be.false;
      expect(archivedFromQuery.type).to.equal('BANK_ACCOUNT');
    });

    it('returns name and data for saved payout methods when collective admin queries', async () => {
      const user = await fakeUser();
      await fakePayoutMethod({
        type: PayoutMethodTypes.BANK_ACCOUNT,
        name: 'My Bank',
        CollectiveId: user.CollectiveId,
        isSaved: true,
        data: {
          accountHolderName: 'Holder',
          currency: 'EUR',
          type: 'IBAN',
          details: { iban: 'FR999999999' },
        },
      });

      const result = await graphqlQueryV2(
        gql`
          query Account($slug: String!) {
            account(slug: $slug) {
              id
              payoutMethods {
                id
                name
                data
                isSaved
              }
            }
          }
        `,
        { slug: user.collective.slug },
        user,
      );
      expect(result.errors).to.not.exist;
      const pm = result.data.account.payoutMethods.find(p => p.name === 'My Bank');
      expect(pm).to.exist;
      expect(pm.name).to.equal('My Bank');
      expect(pm.data).to.exist;
      expect(pm.isSaved).to.be.true;
    });
  });
});

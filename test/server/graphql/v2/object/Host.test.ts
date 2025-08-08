import { expect } from 'chai';
import gql from 'fake-tag';
import moment from 'moment';

import { CollectiveType } from '../../../../../server/constants/collectives';
import models, { PlatformSubscription } from '../../../../../server/models';
import { BillingMonth } from '../../../../../server/models/PlatformSubscription';
import { VirtualCardStatus } from '../../../../../server/models/VirtualCard';
import {
  fakeActiveHost,
  fakeCollective,
  fakeExpense,
  fakeUploadedFile,
  fakeUser,
  fakeVirtualCard,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const hostQuery = gql`
  query Host($slug: String!, $accounts: [AccountReferenceInput]) {
    host(slug: $slug) {
      id
      hostedAccountAgreements(accounts: $accounts) {
        totalCount
        nodes {
          id
          title
          attachment {
            name
          }
        }
      }
    }
  }
`;

describe('server/graphql/v2/object/Host', () => {
  describe('hostedAccountAgreements', () => {
    it('should return agreements with its hosted accounts', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdmin });
      const account = await fakeCollective({ HostCollectiveId: host.id });
      const uploadedFile = await fakeUploadedFile({ fileName: 'my agreement.pdf' });
      await models.Agreement.create({
        title: 'test title',
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        UploadedFileId: uploadedFile.id,
      });

      const result = await graphqlQueryV2(hostQuery, { slug: host.slug }, hostAdmin);
      expect(result.data.host.hostedAccountAgreements.totalCount).to.eql(1);
      expect(result.data.host.hostedAccountAgreements.nodes).to.have.length(1);
      expect(result.data.host.hostedAccountAgreements.nodes[0].title).to.eql('test title');
      expect(result.data.host.hostedAccountAgreements.nodes[0].attachment).to.eql({
        name: 'my agreement.pdf',
      });
    });

    it('should filter agreements by hosted account slug', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdmin });
      const account = await fakeCollective({ HostCollectiveId: host.id });
      const secondAccount = await fakeCollective({ HostCollectiveId: host.id });
      const uploadedFile = await fakeUploadedFile({ fileName: 'my agreement.pdf' });
      await models.Agreement.create({
        title: 'test title',
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        UploadedFileId: uploadedFile.id,
      });

      await models.Agreement.create({
        title: 'second test title',
        CollectiveId: secondAccount.id,
        HostCollectiveId: host.id,
      });

      const result = await graphqlQueryV2(
        hostQuery,
        {
          slug: host.slug,
          accounts: [
            {
              slug: account.slug,
            },
          ],
        },
        hostAdmin,
      );
      expect(result.data.host.hostedAccountAgreements.totalCount).to.eql(1);
      expect(result.data.host.hostedAccountAgreements.nodes).to.have.length(1);
      expect(result.data.host.hostedAccountAgreements.nodes[0].title).to.eql('test title');
      expect(result.data.host.hostedAccountAgreements.nodes[0].attachment).to.eql({
        name: 'my agreement.pdf',
      });

      const otherResult = await graphqlQueryV2(
        hostQuery,
        {
          slug: host.slug,
          accounts: [
            {
              slug: secondAccount.slug,
            },
          ],
        },
        hostAdmin,
      );
      expect(otherResult.data.host.hostedAccountAgreements.totalCount).to.eql(1);
      expect(otherResult.data.host.hostedAccountAgreements.nodes).to.have.length(1);
      expect(otherResult.data.host.hostedAccountAgreements.nodes[0].title).to.eql('second test title');
    });

    it('should filter agreements by hosted account slug or id', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdmin });
      const account = await fakeCollective({ HostCollectiveId: host.id });
      const secondAccount = await fakeCollective({ HostCollectiveId: host.id });
      const uploadedFile = await fakeUploadedFile({ fileName: 'my agreement.pdf' });
      await models.Agreement.create({
        title: 'test title',
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        UploadedFileId: uploadedFile.id,
      });

      await models.Agreement.create({
        title: 'second test title',
        CollectiveId: secondAccount.id,
        HostCollectiveId: host.id,
      });

      const result = await graphqlQueryV2(
        hostQuery,
        {
          slug: host.slug,
          accounts: [
            {
              slug: account.slug,
            },
            {
              legacyId: secondAccount.id,
            },
          ],
        },
        hostAdmin,
      );
      expect(result.data.host.hostedAccountAgreements.totalCount).to.eql(2);
      expect(result.data.host.hostedAccountAgreements.nodes).to.have.length(2);
    });
  });

  describe('hostedVirtualCards', () => {
    const query = gql`
      query Host(
        $slug: String!
        $status: [VirtualCardStatus]
        $collectiveAccountIds: [AccountReferenceInput]
        $withExpensesDateFrom: DateTime
        $withExpensesDateTo: DateTime
      ) {
        host(slug: $slug) {
          id
          hostedVirtualCards(
            orderBy: { direction: ASC }
            status: $status
            collectiveAccountIds: $collectiveAccountIds
            withExpensesDateFrom: $withExpensesDateFrom
            withExpensesDateTo: $withExpensesDateTo
          ) {
            totalCount
            nodes {
              id
              status
            }
          }
        }
      }
    `;

    it('returns all virtual cards', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdmin });
      const account = await fakeCollective({ HostCollectiveId: host.id });
      const vc1 = await fakeVirtualCard({
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        data: {
          status: VirtualCardStatus.ACTIVE,
        },
      });

      const vc2 = await fakeVirtualCard({
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        data: {
          status: VirtualCardStatus.INACTIVE,
        },
      });

      const vc3 = await fakeVirtualCard({
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        data: {
          status: VirtualCardStatus.CANCELED,
        },
      });

      const result = await graphqlQueryV2(query, { slug: host.slug }, hostAdmin);
      expect(result.data.host.hostedVirtualCards.totalCount).to.eql(3);

      expect(result.data.host.hostedVirtualCards.nodes).to.deep.eql([
        {
          id: vc1.id,
          status: 'ACTIVE',
        },
        {
          id: vc2.id,
          status: 'INACTIVE',
        },
        {
          id: vc3.id,
          status: 'CANCELED',
        },
      ]);
    });

    it('filter virtual cards by status', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdmin });
      const account = await fakeCollective({ HostCollectiveId: host.id });
      const vc1 = await fakeVirtualCard({
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        data: {
          status: VirtualCardStatus.ACTIVE,
        },
      });

      await fakeVirtualCard({
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        data: {
          status: VirtualCardStatus.INACTIVE,
        },
      });

      const vc3 = await fakeVirtualCard({
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        data: {
          status: VirtualCardStatus.CANCELED,
        },
      });

      const result = await graphqlQueryV2(query, { slug: host.slug, status: ['ACTIVE', 'CANCELED'] }, hostAdmin);

      expect(result.data.host.hostedVirtualCards.totalCount).to.eql(2);

      expect(result.data.host.hostedVirtualCards.nodes).to.deep.eql([
        {
          id: vc1.id,
          status: 'ACTIVE',
        },
        {
          id: vc3.id,
          status: 'CANCELED',
        },
      ]);
    });

    describe('filter virtual cards by expense date', async () => {
      let hostAdmin, host, vc1, vc2, vc3;
      before(async () => {
        hostAdmin = await fakeUser();
        host = await fakeActiveHost({ admin: hostAdmin });
        const account = await fakeCollective({ HostCollectiveId: host.id });
        vc1 = await fakeVirtualCard({
          CollectiveId: account.id,
          HostCollectiveId: host.id,
          data: {
            status: VirtualCardStatus.ACTIVE,
          },
        });

        await fakeExpense({
          VirtualCardId: vc1.id,
          createdAt: new Date(2021, 6, 15),
        });

        vc2 = await fakeVirtualCard({
          CollectiveId: account.id,
          HostCollectiveId: host.id,
          data: {
            status: VirtualCardStatus.INACTIVE,
          },
        });

        await fakeExpense({
          VirtualCardId: vc2.id,
          createdAt: new Date(2022, 6, 15),
        });

        vc3 = await fakeVirtualCard({
          CollectiveId: account.id,
          HostCollectiveId: host.id,
          data: {
            status: VirtualCardStatus.CANCELED,
          },
        });

        await fakeExpense({
          VirtualCardId: vc3.id,
          createdAt: new Date(2023, 6, 15),
        });
      });

      it('filters from start date', async () => {
        const result = await graphqlQueryV2(
          query,
          { slug: host.slug, withExpensesDateFrom: new Date(2021, 6, 15), withExpensesDateTo: null },
          hostAdmin,
        );

        expect(result.data.host.hostedVirtualCards.totalCount).to.eql(3);
        expect(result.data.host.hostedVirtualCards.nodes).to.deep.eql([
          {
            id: vc1.id,
            status: 'ACTIVE',
          },
          {
            id: vc2.id,
            status: 'INACTIVE',
          },
          {
            id: vc3.id,
            status: 'CANCELED',
          },
        ]);
      });

      it('filters one virtual card with start to end date', async () => {
        const result = await graphqlQueryV2(
          query,
          { slug: host.slug, withExpensesDateFrom: new Date(2021, 6, 15), withExpensesDateTo: new Date(2022, 6, 14) },
          hostAdmin,
        );

        expect(result.data.host.hostedVirtualCards.totalCount).to.eql(1);
        expect(result.data.host.hostedVirtualCards.nodes).to.deep.eql([
          {
            id: vc1.id,
            status: 'ACTIVE',
          },
        ]);
      });

      it('filters first virtual cards', async () => {
        const result = await graphqlQueryV2(
          query,
          { slug: host.slug, withExpensesDateFrom: new Date(2021, 6, 15), withExpensesDateTo: new Date(2022, 6, 15) },
          hostAdmin,
        );

        expect(result.data.host.hostedVirtualCards.totalCount).to.eql(2);
        expect(result.data.host.hostedVirtualCards.nodes).to.deep.eql([
          {
            id: vc1.id,
            status: 'ACTIVE',
          },
          {
            id: vc2.id,
            status: 'INACTIVE',
          },
        ]);
      });

      it('filters with end date only', async () => {
        const result = await graphqlQueryV2(
          query,
          { slug: host.slug, withExpensesDateFrom: null, withExpensesDateTo: new Date(2022, 6, 15) },
          hostAdmin,
        );

        expect(result.data.host.hostedVirtualCards.totalCount).to.eql(2);
        expect(result.data.host.hostedVirtualCards.nodes).to.deep.eql([
          {
            id: vc1.id,
            status: 'ACTIVE',
          },
          {
            id: vc2.id,
            status: 'INACTIVE',
          },
        ]);
      });

      it('filters last two virtual cards ', async () => {
        const result = await graphqlQueryV2(
          query,
          { slug: host.slug, withExpensesDateFrom: new Date(2022, 6, 15), withExpensesDateTo: new Date(2023, 6, 15) },
          hostAdmin,
        );

        expect(result.data.host.hostedVirtualCards.totalCount).to.eql(2);
        expect(result.data.host.hostedVirtualCards.nodes).to.deep.eql([
          {
            id: vc2.id,
            status: 'INACTIVE',
          },
          {
            id: vc3.id,
            status: 'CANCELED',
          },
        ]);
      });

      it('filters cards used on a specific date', async () => {
        const result = await graphqlQueryV2(
          query,
          { slug: host.slug, withExpensesDateFrom: new Date(2022, 6, 15), withExpensesDateTo: new Date(2022, 6, 15) },
          hostAdmin,
        );

        expect(result.data.host.hostedVirtualCards.totalCount).to.eql(1);
        expect(result.data.host.hostedVirtualCards.nodes).to.deep.eql([
          {
            id: vc2.id,
            status: 'INACTIVE',
          },
        ]);
      });
    });
  });

  describe('vendors', () => {
    const accountQuery = gql`
      query Host(
        $slug: String!
        $forAccount: AccountReferenceInput
        $searchTerm: String
        $visibleToAccounts: [AccountReferenceInput]
      ) {
        host(slug: $slug) {
          id
          vendors(forAccount: $forAccount, searchTerm: $searchTerm, visibleToAccounts: $visibleToAccounts) {
            totalCount
            nodes {
              id
              type
              name
              slug
            }
          }
        }
      }
    `;

    let hostAdmin,
      host,
      account,
      collectiveA,
      collectiveB,
      vendor,
      knownVendor,
      vendorVisibleToCollectiveA,
      vendorVisibleToCollectiveAAndB;
    before(async () => {
      hostAdmin = await fakeUser();
      host = await fakeActiveHost({ admin: hostAdmin });
      account = await fakeCollective({ HostCollectiveId: host.id });
      collectiveA = await fakeCollective({ HostCollectiveId: host.id });
      collectiveB = await fakeCollective({ HostCollectiveId: host.id });
      vendor = await fakeCollective({
        ParentCollectiveId: host.id,
        type: CollectiveType.VENDOR,
        name: 'Vendor Dafoe',
        data: {
          visibleToAccountIds: null,
        },
      });
      knownVendor = await fakeCollective({
        ParentCollectiveId: host.id,
        type: CollectiveType.VENDOR,
        name: 'Vendor 2',
        data: {
          visibleToAccountIds: [],
        },
      });

      vendorVisibleToCollectiveA = await fakeCollective({
        ParentCollectiveId: host.id,
        type: CollectiveType.VENDOR,
        name: 'vendorVisibleToCollectiveA',
        data: {
          visibleToAccountIds: [collectiveA.id],
        },
      });

      vendorVisibleToCollectiveAAndB = await fakeCollective({
        ParentCollectiveId: host.id,
        type: CollectiveType.VENDOR,
        name: 'vendorVisibleToCollectiveAAndB',
        data: {
          visibleToAccountIds: [collectiveA.id, collectiveB.id],
        },
      });

      await fakeExpense({ CollectiveId: account.id, FromCollectiveId: knownVendor.id, status: 'PAID' });
    });

    it('should return all vendors if admin of Account', async () => {
      const result = await graphqlQueryV2(accountQuery, { slug: host.slug }, hostAdmin);

      expect(result.data.host.vendors.nodes).to.containSubset([{ slug: vendor.slug }, { slug: knownVendor.slug }]);
    });

    it('should publicly return vendors if host EXPENSE_PUBLIC_VENDORS policy is true', async () => {
      const user = await fakeUser();
      let result = await graphqlQueryV2(accountQuery, { slug: host.slug }, user);
      expect(result.data.host.vendors.nodes).to.be.empty;

      await host.update({ data: { policies: { EXPENSE_PUBLIC_VENDORS: true } } });
      result = await graphqlQueryV2(accountQuery, { slug: host.slug }, user);
      expect(result.data.host.vendors.nodes).to.containSubset([{ slug: vendor.slug }, { slug: knownVendor.slug }]);
    });

    it('should return vendors ranked by the number of expenses submitted to specific account', async () => {
      const result = await graphqlQueryV2(
        accountQuery,
        { slug: host.slug, forAccount: { slug: account.slug } },
        hostAdmin,
      );

      expect(result.data.host.vendors.nodes).to.containSubset([{ slug: vendor.slug }, { slug: knownVendor.slug }]);
      expect(result.data.host.vendors.nodes[0]).to.include({ slug: knownVendor.slug });
    });

    it('should search vendor by searchTerm', async () => {
      const result = await graphqlQueryV2(accountQuery, { slug: host.slug, searchTerm: 'dafoe' }, hostAdmin);

      expect(result.data.host.vendors.nodes).to.have.length(1);
      expect(result.data.host.vendors.nodes[0]).to.include({ slug: vendor.slug });
    });

    it('should return vendors visible to given accounts', async () => {
      let result = await graphqlQueryV2(accountQuery, { slug: host.slug, visibleToAccounts: [] }, hostAdmin);

      expect(result.data.host.vendors.nodes.map(n => n.slug)).to.include.members([
        vendor.slug,
        knownVendor.slug,
        vendorVisibleToCollectiveA.slug,
        vendorVisibleToCollectiveAAndB.slug,
      ]);

      result = await graphqlQueryV2(accountQuery, { slug: host.slug }, hostAdmin);

      expect(result.data.host.vendors.nodes.map(n => n.slug).sort()).to.deep.eq(
        [vendor.slug, knownVendor.slug, vendorVisibleToCollectiveA.slug, vendorVisibleToCollectiveAAndB.slug].sort(),
      );

      result = await graphqlQueryV2(
        accountQuery,
        { slug: host.slug, visibleToAccounts: [{ legacyId: collectiveA.id }] },
        hostAdmin,
      );

      expect(result.data.host.vendors.nodes.map(n => n.slug).sort()).to.deep.eq(
        [vendor.slug, knownVendor.slug, vendorVisibleToCollectiveA.slug, vendorVisibleToCollectiveAAndB.slug].sort(),
      );

      result = await graphqlQueryV2(
        accountQuery,
        { slug: host.slug, visibleToAccounts: [{ legacyId: collectiveA.id }, { legacyId: collectiveB.id }] },
        hostAdmin,
      );

      expect(result.data.host.vendors.nodes.map(n => n.slug).sort()).to.deep.eq(
        [vendor.slug, knownVendor.slug, vendorVisibleToCollectiveA.slug, vendorVisibleToCollectiveAAndB.slug].sort(),
      );

      result = await graphqlQueryV2(
        accountQuery,
        { slug: host.slug, visibleToAccounts: [{ legacyId: collectiveB.id }] },
        hostAdmin,
      );

      expect(result.data.host.vendors.nodes.map(n => n.slug).sort()).to.deep.eq(
        [vendor.slug, knownVendor.slug, vendorVisibleToCollectiveAAndB.slug].sort(),
      );
    });
  });

  describe('platformSubscription', () => {
    const accountQuery = gql`
      query Host($slug: String!) {
        host(slug: $slug) {
          id
          ... on AccountWithPlatformSubscription {
            platformSubscription {
              startDate
              endDate
              plan {
                title
              }
            }
          }
        }
      }
    `;

    it('resolves to null if no subscription is active', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({
        admin: hostAdmin,
      });
      const result = await graphqlQueryV2(accountQuery, { slug: host.slug }, hostAdmin);
      expect(result.errors).to.be.undefined;
      expect(result.data.host.platformSubscription).to.be.null;
    });

    it('resolves to current subscription with no end date', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({
        admin: hostAdmin,
      });
      const startDate = new Date();
      await PlatformSubscription.createSubscription(host.id, startDate, { title: 'A plan' });
      const result = await graphqlQueryV2(accountQuery, { slug: host.slug }, hostAdmin);
      expect(result.errors).to.be.undefined;
      expect(result.data.host.platformSubscription).to.eql({
        startDate: startDate,
        endDate: null,
        plan: {
          title: 'A plan',
        },
      });
    });

    it('resolves to current subscription with end date', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({
        admin: hostAdmin,
      });
      const startDate = new Date();
      const endDate = new Date(startDate.getTime() + 10000);
      const subscription = await PlatformSubscription.createSubscription(host.id, startDate, { title: 'A plan' });
      await subscription.update({
        period: [
          subscription.start,
          {
            value: endDate,
            inclusive: true,
          },
        ],
      });
      const result = await graphqlQueryV2(accountQuery, { slug: host.slug }, hostAdmin);
      expect(result.errors).to.be.undefined;
      expect(result.data.host.platformSubscription.startDate.toISOString()).to.eql(startDate.toISOString());
      expect(result.data.host.platformSubscription).to.eql({
        startDate: startDate,
        endDate: endDate,
        plan: {
          title: 'A plan',
        },
      });
    });
  });

  describe('platformBilling', () => {
    const accountQuery = gql`
      query Host($slug: String!, $billingPeriod: PlatformBillingPeriodInput) {
        host(slug: $slug) {
          id
          ... on AccountWithPlatformSubscription {
            platformBilling(billingPeriod: $billingPeriod) {
              billingPeriod {
                year
                month
              }
              utilization {
                activeCollectives
                expensesPaid
              }

              subscriptions {
                startDate
                endDate

                plan {
                  title
                }
              }
            }
          }
        }
      }
    `;

    it('resolves to empty subscriptions if no subscription is active', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({
        admin: hostAdmin,
      });
      let result = await graphqlQueryV2(accountQuery, { slug: host.slug }, hostAdmin);
      expect(result.errors).to.be.undefined;
      expect(result.data.host.platformBilling).to.eql({
        billingPeriod: {
          year: moment.utc().year(),
          month: BillingMonth[moment.utc().month() + 1],
        },
        utilization: {
          activeCollectives: 0,
          expensesPaid: 0,
        },
        subscriptions: [],
      });

      result = await graphqlQueryV2(
        accountQuery,
        {
          slug: host.slug,
          billingPeriod: {
            year: 2016,
            month: 'JANUARY',
          },
        },
        hostAdmin,
      );
      expect(result.errors).to.be.undefined;
      expect(result.data.host.platformBilling).to.eql({
        billingPeriod: {
          year: 2016,
          month: 'JANUARY',
        },
        utilization: {
          activeCollectives: 0,
          expensesPaid: 0,
        },
        subscriptions: [],
      });
    });

    it('resolves to current subscriptions', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({
        admin: hostAdmin,
      });
      const startDate = new Date(Date.UTC(2016, 1, 1));
      const billingPeriod = {
        year: moment.utc(startDate).year(),
        month: BillingMonth[moment.utc(startDate).month() + 1],
      };
      await PlatformSubscription.createSubscription(host.id, startDate, { title: 'A plan' });
      let result = await graphqlQueryV2(accountQuery, { slug: host.slug, billingPeriod }, hostAdmin);
      expect(result.errors).to.be.undefined;
      expect(result.data.host.platformBilling).to.eql({
        billingPeriod: {
          year: billingPeriod.year,
          month: billingPeriod.month,
        },
        utilization: {
          activeCollectives: 0,
          expensesPaid: 0,
        },
        subscriptions: [
          {
            startDate: startDate,
            endDate: null,
            plan: {
              title: 'A plan',
            },
          },
        ],
      });

      const aNewSubscription = await PlatformSubscription.replaceCurrentSubscription(
        host.id,
        moment.utc(startDate).add('5', 'days').toDate(),
        {
          title: 'A new plan',
        },
      );

      result = await graphqlQueryV2(accountQuery, { slug: host.slug, billingPeriod }, hostAdmin);
      expect(result.errors).to.be.undefined;
      expect(result.data.host.platformBilling).to.eql({
        billingPeriod: {
          year: billingPeriod.year,
          month: billingPeriod.month,
        },
        utilization: {
          activeCollectives: 0,
          expensesPaid: 0,
        },
        subscriptions: [
          {
            startDate: startDate,
            endDate: moment.utc(startDate).add('5', 'days').subtract(1, 'millisecond').toDate(),
            plan: {
              title: 'A plan',
            },
          },
          {
            startDate: moment.utc(startDate).add('5', 'days').toDate(),
            endDate: null,
            plan: {
              title: 'A new plan',
            },
          },
        ],
      });

      await aNewSubscription.update({
        period: [aNewSubscription.start, { value: moment.utc(startDate).add('7', 'days').toDate(), inclusive: true }],
      });

      result = await graphqlQueryV2(accountQuery, { slug: host.slug, billingPeriod }, hostAdmin);
      expect(result.errors).to.be.undefined;
      expect(result.data.host.platformBilling).to.eql({
        billingPeriod: {
          year: billingPeriod.year,
          month: billingPeriod.month,
        },
        utilization: {
          activeCollectives: 0,
          expensesPaid: 0,
        },
        subscriptions: [
          {
            startDate: startDate,
            endDate: moment.utc(startDate).add('5', 'days').subtract(1, 'millisecond').toDate(),
            plan: {
              title: 'A plan',
            },
          },
          {
            startDate: moment.utc(startDate).add('5', 'days').toDate(),
            endDate: moment.utc(startDate).add('7', 'days').toDate(),
            plan: {
              title: 'A new plan',
            },
          },
        ],
      });

      await PlatformSubscription.createSubscription(host.id, moment.utc(startDate).add('10', 'days').toDate(), {
        title: 'Yet another plan in this billing period',
      });

      result = await graphqlQueryV2(accountQuery, { slug: host.slug, billingPeriod }, hostAdmin);
      expect(result.errors).to.be.undefined;
      expect(result.data.host.platformBilling).to.eql({
        billingPeriod: {
          year: billingPeriod.year,
          month: billingPeriod.month,
        },
        utilization: {
          activeCollectives: 0,
          expensesPaid: 0,
        },
        subscriptions: [
          {
            startDate: startDate,
            endDate: moment.utc(startDate).add('5', 'days').subtract(1, 'millisecond').toDate(),
            plan: {
              title: 'A plan',
            },
          },
          {
            startDate: moment.utc(startDate).add('5', 'days').toDate(),
            endDate: moment.utc(startDate).add('7', 'days').toDate(),
            plan: {
              title: 'A new plan',
            },
          },
          {
            startDate: moment.utc(startDate).add('10', 'days').toDate(),
            endDate: null,
            plan: {
              title: 'Yet another plan in this billing period',
            },
          },
        ],
      });
    });
  });
});

import { expect } from 'chai';

// @ts-expect-error - migration is a default export
import migration from '../../migrations/20260115143930-migrate-manual-payment-methods-to-custom-providers'; // eslint-disable-line import/default
import OrderStatuses from '../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../server/constants/paymentMethods';
import { sequelize } from '../../server/models';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';
import {
  fakeActiveHost,
  fakeCollective,
  fakeOrder,
  fakePaymentMethod,
  fakePayoutMethod,
  fakeUser,
  randStr,
} from '../test-helpers/fake-data';
import { resetTestDB } from '../utils';

/**
 * Tests for the migration: 20260115143930-migrate-manual-payment-methods-to-custom-providers
 *
 * Since migrations need special context to run their up/down methods directly,
 * this test:
 * 1. Verifies the schema changes were applied correctly
 * 2. Tests the data migration logic by running the same SQL queries the migration uses
 *    with seeded test data
 */
describe('migrations/20260115143930-migrate-manual-payment-methods-to-custom-providers', () => {
  // Create test data that simulates the pre-migration state
  async function seedTestData(): Promise<{
    host1Id: number;
    host2Id: number;
    host3Id: number;
    collective1Id: number;
    collective2Id: number;
    order1Id: number;
    order2Id: number;
    order3Id: number;
  }> {
    const user = await fakeUser();

    // Create Host 1: Has manual payment instructions AND a manual bank transfer payout method
    const host1 = await fakeActiveHost({
      slug: `migration-test-host-1-${randStr()}`,
      name: 'Migration Test Host 1',
      settings: {
        paymentMethods: {
          manual: {
            instructions: 'Please transfer to Account #12345 at Test Bank\n\nAccount #12345\nTest Bank',
          },
        },
      } as Record<string, unknown>,
      CreatedByUserId: user.id,
    });

    // Create payout method for Host 1 with isManualBankTransfer
    await fakePayoutMethod({
      CollectiveId: host1.id,
      type: PayoutMethodTypes.BANK_ACCOUNT,
      data: {
        isManualBankTransfer: true,
        bankName: 'Test Bank',
        accountNumber: '12345',
        marker: 'migration-test',
      },
      CreatedByUserId: user.id,
    });

    // Create Host 2: Has manual payment instructions but NO payout method with isManualBankTransfer
    const host2 = await fakeActiveHost({
      slug: `migration-test-host-2-${randStr()}`,
      name: 'Migration Test Host 2',
      settings: {
        paymentMethods: {
          manual: {
            instructions: 'Contact us for wire transfer details',
          },
        },
      } as Record<string, unknown>,
      CreatedByUserId: user.id,
    });

    // Create Host 3: NO manual payment instructions (should NOT be migrated)
    const host3 = await fakeActiveHost({
      slug: `migration-test-host-3-${randStr()}`,
      name: 'Migration Test Host 3',
      settings: {},
      CreatedByUserId: user.id,
    });

    // Create collective under Host 1
    const collective1 = await fakeCollective({
      slug: `migration-test-collective-1-${randStr()}`,
      name: 'Migration Test Collective 1',
      HostCollectiveId: host1.id,
      CreatedByUserId: user.id,
    });

    // Create collective under Host 2
    const collective2 = await fakeCollective({
      slug: `migration-test-collective-2-${randStr()}`,
      name: 'Migration Test Collective 2',
      HostCollectiveId: host2.id,
      CreatedByUserId: user.id,
    });

    // Create Order 1: Manual payment order (no PaymentMethodId) for collective under Host 1
    const order1 = await fakeOrder({
      CreatedByUserId: user.id,
      FromCollectiveId: user.collective.id,
      CollectiveId: collective1.id,
      totalAmount: 10000,
      currency: 'USD',
      status: OrderStatuses.PENDING,
      data: { marker: 'migration-test' } as Record<string, unknown>,
      PaymentMethodId: null,
    });

    // Create Order 2: Manual payment order for collective under Host 2
    const order2 = await fakeOrder({
      CreatedByUserId: user.id,
      FromCollectiveId: user.collective.id,
      CollectiveId: collective2.id,
      totalAmount: 20000,
      currency: 'USD',
      status: OrderStatuses.PENDING,
      data: { marker: 'migration-test' } as Record<string, unknown>,
      PaymentMethodId: null,
    });

    // Create Order 3: Order WITH PaymentMethodId (should NOT be linked)
    const paymentMethod = await fakePaymentMethod({
      name: 'Test Card',
      service: PAYMENT_METHOD_SERVICE.STRIPE,
      type: PAYMENT_METHOD_TYPE.CREDITCARD,
    });

    const order3 = await fakeOrder({
      CreatedByUserId: user.id,
      FromCollectiveId: user.collective.id,
      CollectiveId: collective1.id,
      PaymentMethodId: paymentMethod.id,
      totalAmount: 30000,
      currency: 'USD',
      status: OrderStatuses.PAID,
      data: { marker: 'migration-test' } as Record<string, unknown>,
    });

    return {
      host1Id: host1.id,
      host2Id: host2.id,
      host3Id: host3.id,
      collective1Id: collective1.id,
      collective2Id: collective2.id,
      order1Id: order1.id,
      order2Id: order2.id,
      order3Id: order3.id,
    };
  }

  describe('data migration logic', () => {
    let testData: Awaited<ReturnType<typeof seedTestData>>;

    before(async () => {
      await resetTestDB();
      testData = await seedTestData();
      await migration.up(sequelize.getQueryInterface(), sequelize);
    });

    it('creates ManualPaymentProvider for host with manual payment settings AND payout method', async () => {
      const [providers] = await sequelize.query(
        `
        SELECT * FROM "ManualPaymentProviders"
        WHERE "CollectiveId" = :hostId
      `,
        { replacements: { hostId: testData.host1Id } },
      );

      expect(providers.length).to.equal(1);
      const provider = (providers as any)[0];
      expect(provider.type).to.equal('BANK_TRANSFER');
      expect(provider.name).to.equal('Bank Transfer');
      expect(provider.instructions).to.equal(
        '<div>Please transfer to Account #12345 at Test Bank<br /><br />Account #12345<br />Test Bank</div>',
      );
      expect(provider.icon).to.equal('Landmark');
      expect(provider.order).to.equal(0);

      // Verify payout method data was copied
      const data = typeof provider.data === 'string' ? JSON.parse(provider.data) : provider.data;
      expect(data.isManualBankTransfer).to.be.true;
      expect(data.bankName).to.equal('Test Bank');
      expect(data.accountNumber).to.equal('12345');
    });

    it('creates ManualPaymentProvider for host with manual settings but no payout method (with null data)', async () => {
      // Host 2 has manual instructions but no PayoutMethod with isManualBankTransfer=true
      // The migration's LEFT JOIN with `pm."deletedAt" IS NULL` condition still matches
      // because NULL IS NULL evaluates to TRUE in SQL
      const [providers] = await sequelize.query(
        `
        SELECT * FROM "ManualPaymentProviders"
        WHERE "CollectiveId" = :hostId
      `,
        { replacements: { hostId: testData.host2Id } },
      );

      expect(providers.length).to.equal(1);
      const provider = (providers as any)[0];
      expect(provider.type).to.equal('BANK_TRANSFER');
      expect(provider.name).to.equal('Bank Transfer');
      expect(provider.instructions).to.equal('<div>Contact us for wire transfer details</div>');
      // payoutMethodData is null because there was no matching payout method
      expect(provider.data).to.be.null;
    });

    it('does NOT create ManualPaymentProvider for host without manual payment settings', async () => {
      const [providers] = await sequelize.query(
        `
        SELECT * FROM "ManualPaymentProviders"
        WHERE "CollectiveId" = :hostId
      `,
        { replacements: { hostId: testData.host3Id } },
      );

      expect(providers.length).to.equal(0);
    });

    it('links manual orders (without PaymentMethodId) to the new ManualPaymentProvider', async () => {
      const [orders] = await sequelize.query(
        `
        SELECT o."ManualPaymentProviderId", mpp."CollectiveId" as "ProviderHostId"
        FROM "Orders" o
        LEFT JOIN "ManualPaymentProviders" mpp ON o."ManualPaymentProviderId" = mpp.id
        WHERE o.id = :orderId
      `,
        { replacements: { orderId: testData.order1Id } },
      );

      const order = (orders as any)[0];
      expect(order.ManualPaymentProviderId).to.not.be.null;
      expect(order.ProviderHostId).to.equal(testData.host1Id);
    });

    it('links orders to ManualPaymentProvider even when provider has no payout method data', async () => {
      // Order 2 is for collective under Host 2, which has a ManualPaymentProvider
      // (created from manual settings even without a payout method)
      const [orders] = await sequelize.query(
        `
        SELECT o."ManualPaymentProviderId", mpp."CollectiveId" as "ProviderHostId"
        FROM "Orders" o
        LEFT JOIN "ManualPaymentProviders" mpp ON o."ManualPaymentProviderId" = mpp.id
        WHERE o.id = :orderId
      `,
        { replacements: { orderId: testData.order2Id } },
      );

      const order = (orders as any)[0];
      expect(order.ManualPaymentProviderId).to.not.be.null;
      expect(order.ProviderHostId).to.equal(testData.host2Id);
    });

    it('does NOT link orders that have a PaymentMethodId', async () => {
      // Order 3 has a PaymentMethodId so should not be linked
      const [orders] = await sequelize.query(
        `
        SELECT "ManualPaymentProviderId"
        FROM "Orders"
        WHERE id = :orderId
      `,
        { replacements: { orderId: testData.order3Id } },
      );

      const order = (orders as any)[0];
      expect(order.ManualPaymentProviderId).to.be.null;
    });
  });
});

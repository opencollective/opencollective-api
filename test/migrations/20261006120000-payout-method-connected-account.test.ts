import { expect } from 'chai';
import { QueryTypes } from 'sequelize';

// @ts-expect-error - migration uses module.exports interop
import migration from '../../migrations/20261006120000-payout-method-connected-account'; // eslint-disable-line import/default
import { sequelize } from '../../server/models';
import { fakeConnectedAccount, fakePayoutMethod } from '../test-helpers/fake-data';
import { resetTestDB } from '../utils';

describe('migrations/20261006120000-payout-method-connected-account', () => {
  beforeEach(() => resetTestDB());

  it('backfills live and archived links, handles invalid IDs, and restores links on rollback', async () => {
    const connectedAccount = await fakeConnectedAccount({ service: 'paypal' });
    const deletedAccount = await fakeConnectedAccount({ service: 'paypal' });
    const stripeAccount = await fakeConnectedAccount({ service: 'stripe' });
    const linked = await fakePayoutMethod({ ConnectedAccountId: connectedAccount.id });
    const archived = await fakePayoutMethod({ ConnectedAccountId: deletedAccount.id });
    const dangling = await fakePayoutMethod();
    const malformed = await fakePayoutMethod();
    const manual = await fakePayoutMethod();
    await archived.destroy();
    await deletedAccount.destroy();

    const queryInterface = sequelize.getQueryInterface();
    await migration.down(queryInterface);
    try {
      await sequelize.query(
        `UPDATE "PayoutMethods"
         SET data = data || jsonb_build_object('connectedAccountId', :id)
         WHERE id = :payoutMethodId`,
        { replacements: { id: '999999999999999999999999999', payoutMethodId: dangling.id } },
      );
      await sequelize.query(
        `UPDATE "PayoutMethods"
         SET data = data || '{"connectedAccountId":"invalid"}'::jsonb
         WHERE id = :payoutMethodId`,
        { replacements: { payoutMethodId: malformed.id } },
      );
      await migration.up(queryInterface);
      const rows = await sequelize.query<{ id: number; ConnectedAccountId: number | null; data: object }>(
        'SELECT id, "ConnectedAccountId", data FROM "PayoutMethods" ORDER BY id',
        { type: QueryTypes.SELECT },
      );
      expect(rows.find(row => row.id === linked.id).ConnectedAccountId).to.equal(connectedAccount.id);
      expect(rows.find(row => row.id === archived.id).ConnectedAccountId).to.equal(deletedAccount.id);
      expect(rows.find(row => row.ConnectedAccountId === stripeAccount.id)).to.exist;
      for (const pm of [dangling, malformed, manual]) {
        expect(rows.find(row => row.id === pm.id).ConnectedAccountId).to.be.null;
      }
      for (const row of rows) {
        expect(row.data).not.to.have.property('connectedAccountId');
      }
      await linked.reload();
      expect(linked.data).to.have.property('email');

      await migration.down(queryInterface);
      const [restored] = await sequelize.query<{ data: { connectedAccountId: number } }>(
        'SELECT data FROM "PayoutMethods" WHERE id = :id',
        { type: QueryTypes.SELECT, replacements: { id: linked.id } },
      );
      expect(restored.data.connectedAccountId).to.equal(connectedAccount.id);
    } finally {
      const columns = await queryInterface.describeTable('PayoutMethods');
      if (!columns.ConnectedAccountId) {
        await migration.up(queryInterface);
      }
    }
  });
});

import { expect } from 'chai';

// @ts-expect-error - migration uses module.exports interop
import migration from '../../migrations/20260601120000-migrate-order-tax-id-number-to-tax-id-number'; // eslint-disable-line import/default
import { sequelize } from '../../server/models';
import { fakeCollective, fakeOrder, fakeTransaction, fakeUser } from '../test-helpers/fake-data';
import { resetTestDB } from '../utils';

describe('migrations/20260601120000-migrate-order-tax-id-number-to-tax-id-number', () => {
  beforeEach(() => resetTestDB());

  it('moves data.tax.taxIDNumber to data.tax.idNumber and removes taxIDNumber', async () => {
    const user = await fakeUser();
    const collective = await fakeCollective();
    const order = await fakeOrder({
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      data: {
        tax: {
          id: 'VAT',
          // @ts-expect-error the field is gone from the type
          taxIDNumber: 'FRXX999999997',
          percentage: 20,
        },
      },
    });

    await migration.up(sequelize.getQueryInterface());
    await order.reload();

    expect(order.data.tax).to.deep.equal({
      id: 'VAT',
      idNumber: 'FRXX999999997',
      percentage: 20,
    });
  });

  it('only removes taxIDNumber when idNumber is already set', async () => {
    const user = await fakeUser();
    const collective = await fakeCollective();
    const order = await fakeOrder({
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      data: {
        tax: {
          id: 'VAT',
          // @ts-expect-error the field is gone from the type
          taxIDNumber: 'LEGACY-ID',
          idNumber: 'CANONICAL-ID',
          percentage: 20,
        },
      },
    });

    await migration.up(sequelize.getQueryInterface());
    await order.reload();

    expect(order.data.tax).to.deep.equal({
      id: 'VAT',
      idNumber: 'CANONICAL-ID',
      percentage: 20,
    });
  });

  it('moves data.tax.taxIDNumberFrom to data.tax.idNumberFrom', async () => {
    const user = await fakeUser();
    const collective = await fakeCollective();
    const order = await fakeOrder({
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      data: {
        tax: {
          id: 'VAT',
          percentage: 20,
          // @ts-expect-error the field is gone from the type
          taxIDNumberFrom: 'FRXX999999999',
        },
      },
    });

    await migration.up(sequelize.getQueryInterface());
    await order.reload();

    expect(order.data.tax).to.deep.equal({
      id: 'VAT',
      percentage: 20,
      idNumberFrom: 'FRXX999999999',
    });
  });

  it('reverts contributor tax ID on down', async () => {
    const user = await fakeUser();
    const collective = await fakeCollective();
    const order = await fakeOrder({
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      data: {
        tax: {
          id: 'VAT',
          // @ts-expect-error the field is gone from the type
          taxIDNumber: 'FRXX999999997',
          percentage: 20,
        },
      },
    });

    const queryInterface = sequelize.getQueryInterface();
    await migration.up(queryInterface);
    await migration.down(queryInterface);
    await order.reload();

    expect(order.data.tax).to.deep.equal({
      id: 'VAT',
      taxIDNumber: 'FRXX999999997',
      percentage: 20,
    });
  });

  describe('Transactions', () => {
    it('moves data.tax.taxIDNumber to data.tax.idNumber in transactions', async () => {
      const collective = await fakeCollective();
      const transaction = await fakeTransaction({
        CollectiveId: collective.id,
        data: {
          tax: {
            id: 'VAT',
            // @ts-expect-error the field is gone from the type
            taxIDNumber: 'FRXX999999997',
            percentage: 20,
          },
        },
      });

      await migration.up(sequelize.getQueryInterface());
      await transaction.reload();

      expect(transaction.data.tax).to.deep.equal({
        id: 'VAT',
        idNumber: 'FRXX999999997',
        percentage: 20,
      });
    });

    it('only removes taxIDNumber when idNumber is already set in transactions', async () => {
      const collective = await fakeCollective();
      const transaction = await fakeTransaction({
        CollectiveId: collective.id,
        data: {
          tax: {
            id: 'VAT',
            // @ts-expect-error the field is gone from the type
            taxIDNumber: 'LEGACY-ID',
            idNumber: 'CANONICAL-ID',
            percentage: 20,
          },
        },
      });

      await migration.up(sequelize.getQueryInterface());
      await transaction.reload();

      expect(transaction.data.tax).to.deep.equal({
        id: 'VAT',
        idNumber: 'CANONICAL-ID',
        percentage: 20,
      });
    });

    it('moves data.tax.taxIDNumberFrom to data.tax.idNumberFrom in transactions', async () => {
      const collective = await fakeCollective();
      const transaction = await fakeTransaction({
        CollectiveId: collective.id,
        data: {
          tax: {
            id: 'VAT',
            percentage: 20,
            // @ts-expect-error the field is gone from the type
            taxIDNumberFrom: 'FRXX999999999',
          },
        },
      });

      await migration.up(sequelize.getQueryInterface());
      await transaction.reload();

      expect(transaction.data.tax).to.deep.equal({
        id: 'VAT',
        percentage: 20,
        idNumberFrom: 'FRXX999999999',
      });
    });

    it('reverts transaction tax ID on down', async () => {
      const collective = await fakeCollective();
      const transaction = await fakeTransaction({
        CollectiveId: collective.id,
        data: {
          tax: {
            id: 'VAT',
            // @ts-expect-error the field is gone from the type
            taxIDNumber: 'FRXX999999997',
            percentage: 20,
          },
        },
      });

      const queryInterface = sequelize.getQueryInterface();
      await migration.up(queryInterface);
      await migration.down(queryInterface);
      await transaction.reload();

      expect(transaction.data.tax).to.deep.equal({
        id: 'VAT',
        taxIDNumber: 'FRXX999999997',
        percentage: 20,
      });
    });
  });
});

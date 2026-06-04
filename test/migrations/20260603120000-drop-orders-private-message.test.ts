import { expect } from 'chai';
import { QueryTypes } from 'sequelize';

// @ts-expect-error - migration uses module.exports interop
import migration from '../../migrations/20260603120000-drop-orders-private-message'; // eslint-disable-line import/default
import { sequelize } from '../../server/models';
import { resetTestDB } from '../utils';

async function tableHasColumn(table: string, column: string): Promise<boolean> {
  const [{ exists }] = await sequelize.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = :table
          AND column_name = :column
      ) AS exists
    `,
    {
      type: QueryTypes.SELECT,
      replacements: { table, column },
    },
  );

  return exists;
}

describe('migrations/20260603120000-drop-orders-private-message', () => {
  beforeEach(() => resetTestDB());

  it('drops privateMessage from Orders but keeps it on OrderHistories', async () => {
    const queryInterface = sequelize.getQueryInterface();

    if (!(await tableHasColumn('Orders', 'privateMessage'))) {
      await migration.down(queryInterface);
    }

    expect(await tableHasColumn('Orders', 'privateMessage')).to.be.true;
    expect(await tableHasColumn('OrderHistories', 'privateMessage')).to.be.true;

    await migration.up(queryInterface);

    expect(await tableHasColumn('Orders', 'privateMessage')).to.be.false;
    expect(await tableHasColumn('OrderHistories', 'privateMessage')).to.be.true;
  });
});

import debugLib from 'debug';

import { sequelize } from '../../models';

const debug = debugLib('export');

export const restoreRows = async (model: any, rows: Record<string, any>[]) => {
  debug(`\t${model.name} (${rows.length} rows)`);
  return sequelize.transaction(async transaction => {
    const tablename = model.getTableName();
    await sequelize.query(`ALTER TABLE "${tablename}" DISABLE TRIGGER ALL;`, { transaction });
    for (const row of rows) {
      await model
        .create(row, {
          transaction,
          validate: false,
          hooks: false,
          silent: true,
          logging: false,
          raw: false,
          ignoreDuplicates: true,
        })
        .catch(console.error);
    }
    await sequelize.query(`ALTER TABLE "${tablename}" ENABLE TRIGGER ALL;`, { transaction });
  });
};

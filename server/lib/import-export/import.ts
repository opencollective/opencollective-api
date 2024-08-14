import assert from 'assert';

import { sequelize } from '../../models';
import logger from '../logger';

const updateSequence = async (tableName, field) => {
  const [sequences] = await sequelize.query(`SELECT pg_get_serial_sequence('"${tableName}"', '${field}')`);
  const sequence = sequences[0].pg_get_serial_sequence;
  assert(sequence, `No sequence found for table "${tableName}" and field "${field}"`);

  const [ids] = await sequelize.query(`SELECT MAX(${field}) FROM "${tableName}"`);
  const currentVal = ids[0]?.max || 1;
  logger.info(`Updating sequence "${tableName}"."${field}" (${sequence}) to ${currentVal}`);

  await sequelize.query(`SELECT setval('${sequence}', ${currentVal})`);
};

export const resetModelsSequences = async models => {
  for (const model of models) {
    const tableName = model.getTableName();
    const fields = Object.keys(model.tableAttributes);
    for (const field of fields) {
      if (model.tableAttributes[field].autoIncrement) {
        await updateSequence(tableName, field);
      }
    }
  }
};

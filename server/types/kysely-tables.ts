/**
 * Kysely Database interface inferred from Sequelize models.
 * Uses KyselifyModel from kysely-sequelize to derive table row types from Model types.
 * Table names are read from each model's static tableName (Sequelize default or Model.init).
 */
import type { KyselifyModel } from 'kysely-sequelize';

import models from '../models';

type ModelWithTableName = { tableName: string };

/**
 * Map from model name (key of models) to actual table name in the database.
 * Auto-generated from each model's static tableName
 */
export const MODEL_TABLE_NAMES: { [K in keyof typeof models]: string } = Object.fromEntries(
  (Object.keys(models) as Array<keyof typeof models>).map(key => [key, (models[key] as ModelWithTableName).tableName]),
) as { [K in keyof typeof models]: string };

/**
 * Database type: for each model K, the table named (models[K].tableName) has row type
 * inferred from that model via KyselifyModel.
 */
export type Database = {
  [K in keyof typeof models as (typeof models)[K] extends ModelWithTableName
    ? (typeof models)[K]['tableName']
    : never]: KyselifyModel<InstanceType<(typeof models)[K]>>;
};

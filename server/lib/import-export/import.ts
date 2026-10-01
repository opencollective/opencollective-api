import assert from 'assert';
import fs from 'fs';
import readline from 'readline';

import debugLib from 'debug';
import { isEmpty, isNil, isUndefined, mapKeys, mapValues, pick, set } from 'lodash';
import type {
  Model as SequelizeModel,
  ModelAttributeColumnOptions,
  ModelAttributeColumnReferencesOptions,
  ModelStatic,
} from 'sequelize';
import { QueryTypes } from 'sequelize';

import models, { ModelNames, sequelize } from '../../models';
import logger from '../logger';

const debug = debugLib('import');

export const MODELS_ARRAY = Object.values(models);

const DEFAULT_VALUES: Partial<Record<ModelNames, Record<string, unknown>>> = {
  PayoutMethod: {
    isSaved: false,
    data: {},
  },
  PaymentMethod: {
    currency: 'USD',
  },
};

export const populateDefaultValues = <T extends Record<string, unknown>>(row: T): T => {
  const defaultValues = DEFAULT_VALUES[row.model as ModelNames];
  if (defaultValues) {
    return mapValues(row, (value, key) =>
      !isUndefined(defaultValues[key]) && isNil(value) ? defaultValues[key] : value,
    ) as T;
  } else {
    return row;
  }
};

const updateSequence = async (tableName, field) => {
  const [sequences] = await sequelize.query<{ pg_get_serial_sequence: string | null }>(
    `SELECT pg_get_serial_sequence('"${tableName}"', '${field}')`,
    { type: QueryTypes.SELECT },
  );
  const sequence = sequences[0].pg_get_serial_sequence;
  assert(sequence, `No sequence found for table "${tableName}" and field "${field}"`);

  const [ids] = await sequelize.query<{ max: number }>(`SELECT MAX(${field}) FROM "${tableName}"`, {
    type: QueryTypes.SELECT,
  });
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

/**
 * Return the next valid primary key for a given model.
 */
const getNextPK = async model => {
  const primaryKey = model.primaryKeyAttribute;
  const [sequences] = await sequelize.query<{ pg_get_serial_sequence: string | null }>(
    `SELECT pg_get_serial_sequence('"${model.tableName}"', '${primaryKey}')`,
    { type: QueryTypes.SELECT },
  );
  const sequence = sequences[0].pg_get_serial_sequence;
  assert(sequence, `No sequence found for table "${model.tableName}" and field "${primaryKey}"`);

  const [result] = await sequelize.query<{ nextval: number }>(`SELECT nextval('${sequence}')`, {
    type: QueryTypes.SELECT,
  });
  return result[0].nextval;
};

/**
 * Object mapping model names to their query to find unique instances for deduplication.
 */
const modelsDeduplicationSchema: Record<ModelNames, { unique?: string[] }> = {
  AccountingCategory: {},
  Activity: {},
  Agreement: {},
  Application: {},
  Collective: { unique: ['slug'] },
  Comment: {},
  ConnectedAccount: {},
  Conversation: {},
  ConversationFollower: {},
  CurrencyExchangeRate: {},
  EmojiReaction: {},
  Expense: {},
  ExpenseAttachedFile: {},
  ExpenseItem: {},
  ExportRequest: {},
  HostApplication: {},
  LegalDocument: {},
  Location: {},
  ManualPaymentProvider: {},
  Member: {},
  MemberInvitation: {},
  MigrationLog: {},
  Notification: {},
  OAuthAuthorizationCode: {},
  Order: { unique: ['totalAmount', 'currency', 'createdAt', 'quantity', 'status', 'interval', 'description'] },
  PaymentIntent: {},
  PaymentMethod: { unique: ['uuid'] },
  PayoutMethod: {},
  PaypalPlan: {},
  PaypalProduct: {},
  PersonalToken: {},
  RecurringExpense: {},
  RequiredLegalDocument: {},
  SocialLink: { unique: ['CollectiveId', 'type', 'url'] },
  Subscription: {},
  SuspendedAsset: {},
  Tier: {},
  Transaction: { unique: ['uuid'] },
  TransactionSettlement: {},
  TransactionsImport: {},
  TransactionsImportRow: {},
  Update: { unique: ['slug'] },
  UploadedFile: {},
  User: { unique: ['email', 'emailWaitingForValidation'] },
  UserToken: {},
  UserTwoFactorMethod: {},
  VirtualCard: {},
  VirtualCardRequest: {},
  PlatformSubscription: {},
  KYCVerification: {},
  AccountingCategoryRule: {},
};

/**
 * A record of a JSONL export file: the model name plus all the column values.
 */
type ImportRecord = { model: ModelNames } & Record<string, unknown>;

/**
 * Iterate over each record in a JSONL file.
 */
const forEachRecord = async (file: string, cb: (record: ImportRecord) => Promise<void>) => {
  const fileStream = fs.createReadStream(file);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const record = JSON.parse(line) as ImportRecord;
    await cb(record);
  }
};

const IGNORE = Symbol('IGNORE');
type PKMap = Record<ModelNames, Record<number | string, number | string | typeof IGNORE>>;

const equalDates = (firstDate, secondDate) => {
  if (firstDate && secondDate) {
    if (new Date(firstDate).getTime() === new Date(secondDate).getTime()) {
      return true;
    }
  }
  return false;
};

/**
 * Remap IDs in a JSONL file to avoid conflicts with existing records.
 */
export const remapPKs = async (dataFile: string): Promise<PKMap> => {
  const pkMap = MODELS_ARRAY.reduce((acc, model) => {
    return { ...acc, [model.name]: {} };
  }, {}) as Record<ModelNames, Record<number | string, number | string | typeof IGNORE>>;

  await forEachRecord(dataFile, async record => {
    const model: ModelStatic<SequelizeModel> = models[record.model];
    const primaryKey = model.primaryKeyAttribute;
    const recordPk = record[primaryKey] as number | string;

    // If we have a unique constraint, we need to check if the record already exists
    if (modelsDeduplicationSchema[record.model].unique) {
      const where = pick(record, modelsDeduplicationSchema[record.model].unique);
      const hasNonNullValue = Object.values(where).some(value => !!value);
      if (hasNonNullValue) {
        const existingRecord = await model.findOne({ where, paranoid: false });
        if (existingRecord) {
          // If record exists with same PK, we can mark it for ignoring
          if (existingRecord[primaryKey] === recordPk) {
            debug(`Record ${record.model}#${recordPk} already exists with same id`);
            pkMap[record.model][recordPk] = IGNORE;
            return;
          }
          // Else, we need remap to their existing PK
          else {
            debug(`Record ${record.model}#${recordPk} already exists with different id ${existingRecord[primaryKey]}`);
            pkMap[record.model][recordPk] = existingRecord[primaryKey];
            return;
          }
        }
      }
    }

    // If we don't have a way to detect unique instances or can't find the same record, we need to check if the id is being used...
    if (primaryKey) {
      const matchingRecord = await model.findOne({ where: { [primaryKey]: recordPk }, paranoid: false });
      if (matchingRecord) {
        if (equalDates(matchingRecord.dataValues['createdAt'], record.createdAt)) {
          debug(`Record ${record.model}#${recordPk} already exists with same id and createdAt`);
          pkMap[record.model][recordPk] = IGNORE;
        } else {
          // If the ID is already being used, we'll generate the next valid one and mark it for remapping
          const newId = await getNextPK(model);
          pkMap[record.model][recordPk] = newId;
          debug(`Record ${record.model}#${recordPk} has conflicting id, remaping to ${newId}`);
        }
      }
      // Otherwise we leave the map empty so we can insert the record as is.
    }
  });

  return pkMap;
};

/**
 * Object mapping table names to model names.
 * e.g. { "Users": "User", "Collectives": "Collective", ... }
 */
const TABLE_TO_MODEL = mapValues(
  mapKeys(models, model => model.tableName),
  model => model.name,
);

/**
 * Object mapping model names to model names with an array of columns.
 * e.g. { "Collective": { "User": ["CreatedByUserId"] }, ... }
 */
/**
 * Shape of the `tableAttributes` entries we care about when resolving foreign keys.
 * `fieldName` is added by Sequelize at runtime but is not part of the public typings.
 */
type ModelColumn = ModelAttributeColumnOptions & { fieldName: string };

const FOREIGN_KEYS: Record<ModelNames, Partial<Record<ModelNames, string[]>>> = mapValues(
  models,
  (model: ModelStatic<SequelizeModel>) =>
    Object.values(model.rawAttributes as Record<string, ModelColumn>)
      .filter(column => Boolean(column.references))
      .reduce(
        (acc, column) => {
          const referencedTable = (column.references as ModelAttributeColumnReferencesOptions).model as string;
          const referencedModel = TABLE_TO_MODEL[referencedTable];
          if (acc[referencedModel]) {
            acc[referencedModel].push(column.fieldName);
          } else {
            acc[referencedModel] = [column.fieldName];
          }
          return acc;
        },
        {} as Partial<Record<ModelNames, string[]>>,
      ),
);

/**
 * Merge records from a JSONL file into the database, considering any FK/PK remapped.
 */
export const mergeRecords = async (dataFile: string, pkMap: PKMap, transaction) => {
  let count = 0;

  await forEachRecord(dataFile, async record => {
    const model: ModelStatic<SequelizeModel> = models[record.model];
    const primaryKey = model.primaryKeyAttribute;
    const recordPk = record[primaryKey] as number | string;
    const referencedModels = FOREIGN_KEYS[record.model];
    const remap = pkMap[record.model][recordPk];

    const remappedDependencies = {};
    // Update any foreign keys that may have been remapped
    Object.keys(referencedModels).forEach(referencedModel => {
      const foreignKeys = referencedModels[referencedModel];
      foreignKeys.forEach(foreignKey => {
        const rowPk = record[foreignKey] as number | string;
        const remappedPk = pkMap[referencedModel][rowPk];
        if (remappedPk && remappedPk !== IGNORE) {
          set(remappedDependencies, foreignKey, remappedPk);
          debug(
            `Remaping foreign key: ${record.model}#${recordPk} ${foreignKey} ${rowPk} to ${referencedModel}#${remappedPk}`,
          );
        }
      });
    });

    // If the record already exists with the same ID, we can skip it
    if (remap === IGNORE) {
      debug(`Skipping record: ${record.model}#${recordPk}`);
      return;
    }
    // If the record was remapped, we need to update its primary key
    else if (remap) {
      debug(`Remaping key: ${record.model}#${recordPk} ${primaryKey} to ${remap}`);
      set(record, primaryKey, remap);
    }
    // If the record has any foreign keys that were remapped, we need to update them
    if (!isEmpty(remappedDependencies)) {
      Object.assign(record, remappedDependencies);
    }

    record = populateDefaultValues(record);

    await model.create(record, {
      transaction,
      validate: false,
      hooks: false,
      silent: true,
      logging: false,
      ignoreDuplicates: true,
      raw: true,
      returning: false,
    });
    count++;
  });

  return count;
};

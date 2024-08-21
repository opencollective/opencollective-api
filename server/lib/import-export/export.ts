import debugLib from 'debug';
import { compact, concat, pick, set, uniqBy } from 'lodash';
import { DataType } from 'sequelize';

import type { ModelNames, Models } from '../../models';
import models, { Op, sequelize } from '../../models';
import { crypto } from '../encryption';
import logger from '../logger';

import { getSanitizers } from './sanitize';
import { PartialRequest, RecipeItem } from './types';

const debug = debugLib('export');

type Attributues = {
  allowNull?: boolean;
  field?: string;
  fieldName?: string;
  onDelete?: string;
  onUpdate?: string;
  type: DataType;
  references?: {
    model: string;
    key: string;
  };
};

type Model = {
  name: ModelNames;
  tableName: string;
  getAttributes: () => Record<string, Attributues>;
};

export const buildForeignKeyTree = (models: Models) => {
  const tree: Partial<Record<ModelNames, Partial<Record<ModelNames, string[]>>>> = {};
  const modelsArray = Object.values(models) as Model[];

  modelsArray.forEach(model => {
    const { name: modelName } = model;
    const columns = model.getAttributes();

    Object.values(columns).forEach(column => {
      if (column.references) {
        const referencedModel = modelsArray.find(model => model.tableName === column.references.model);
        if (tree[referencedModel.name]?.[modelName]) {
          tree[referencedModel.name][modelName].push(column.fieldName);
        } else {
          set(tree, `${referencedModel.name}.${modelName}`, [column.fieldName]);
        }
      }
    });
  });

  return tree;
};

const sanitizers = getSanitizers();

const serialize = async (model: ModelNames, req: PartialRequest, document: InstanceType<Models[ModelNames]>) => {
  const baseValues = { ...document.dataValues, model };
  if (!sanitizers[model]) {
    logger.warn(`No sanitizer found for model ${model}`);
    return baseValues;
  }

  const sanitizedValues = await sanitizers[model](document, req);
  if (sanitizedValues === null) {
    return null; // A null return means the record should be skipped
  }

  return { ...baseValues, ...sanitizedValues };
};

type ExportedItem = Record<string, any> & { model: ModelNames; id: number | string };

async function* paginate(model: ModelNames, where: Record<string, any>, order: Record<string, any>, limit: number) {
  let offset = 0;
  let totalCount = 0;
  debug({ model, where });
  do {
    const result = await (models[model] as any).findAndCountAll({ where, order, limit, offset });
    totalCount = result.count;
    yield result.rows;
    offset += limit;
  } while (offset < totalCount);
}

const hashObject = (obj: Record<string, any>) => crypto.hash(JSON.stringify(obj));

export const traverse = async (
  { model, where, order, dependencies, limit = 1000, defaultDependencies = {}, parsed = {}, depth = 1 }: RecipeItem,
  req: PartialRequest,
  callback: (ei: ExportedItem) => Promise<any>,
): Promise<void> => {
  if (model && where) {
    const hasIdField = models[model]['tableAttributes'].id;
    if (!where.id && parsed[model] && hasIdField) {
      where.id = { [Op.notIn]: Array.from(parsed[model]) };
    }

    let records;
    for await (const pageRecords of paginate(model, where, order, limit)) {
      records = await Promise.all(pageRecords.map(record => serialize(model, req, record)));
      records = records.filter(Boolean);

      if (hasIdField) {
        if (!parsed[model]) {
          parsed[model] = new Set(records.map(r => r.id));
        } else {
          records.forEach(r => parsed[model].add(r.id));
        }
      }

      for (const element of records) {
        await callback(element);
      }

      // Inject default dependencies for the model
      dependencies = compact(concat(dependencies, defaultDependencies[model]));
      let queries = [];
      for (const record of records) {
        for (const dep of dependencies) {
          let where = {};
          // If the dependency has a custom function
          if (typeof dep.where === 'function') {
            where = dep.where(record);
          }
          // Find dependency which ID from record foreign key
          else if (dep.from && record[dep.from] && !parsed[dep.model]?.has(record[dep.from])) {
            where['id'] = record[dep.from];
          }
          // Find dependency which foreign key is equal to the record ID
          else if (dep.on) {
            where[dep.on] = record.id;
          } else {
            continue;
          }
          queries.push({ ...dep, where, defaultDependencies, parsed, depth: depth + 1 });
        }
      }
      // Remove duplicates
      queries = uniqBy(queries, query => hashObject(pick(query, ['model', 'where'])));
      // TODO: COMBINE QUERIES FOR THE SAME MODEL
      await Promise.all(queries.map(query => traverse(query, req, callback)));
    }
  }
};

export const getMigrationsHash = async () => {
  const [data] = await sequelize.query('SELECT name FROM "SequelizeMeta" ORDER BY name');
  const migrationNames = data.map(d => d.name);
  return hashObject(migrationNames);
};

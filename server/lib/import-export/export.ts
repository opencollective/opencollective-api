import debugLib from 'debug';
import { compact, concat, keys, pick, set, uniqBy, values } from 'lodash';
import { DataType } from 'sequelize';

import type { ModelNames, Models } from '../../models';
import models, { sequelize } from '../../models';
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

const PAGINATION_LIMIT = 10000;

async function* paginate(model: ModelNames, where: Record<string, any>, order: Record<string, any>, limit?: number) {
  let offset = 0;
  let totalCount = 0;
  if (limit) {
    return await (models[model] as any).findAll({ where, order, limit });
  }
  do {
    const result = await (models[model] as any).findAndCountAll({ where, order, limit: PAGINATION_LIMIT, offset });
    totalCount = result.count;
    yield result.rows;
    offset += PAGINATION_LIMIT;
  } while (offset < totalCount);
}

const hashObject = (obj: Record<string, any>) => crypto.hash(JSON.stringify(obj));

const isTargetWhere = q => {
  const ks = keys(q.where);
  const vs = values(q.where);
  return ks.length === 1 && typeof vs[0] !== 'object';
};

/**
 * Reducer that combines multiple queries that target a single EQ property to a single query with an IN clause
 */
const compactQueries = (queries, maxBatchSize = 500) => {
  const compactableQueries = queries.reduce((acc, query) => {
    if (isTargetWhere(query)) {
      const key = keys(query.where)[0];
      const value = values(query.where)[0];

      const hasExistingQuery = acc.findLast(
        q => q.model === query.model && key === keys(q.where)[0] && q.where[key].length < maxBatchSize,
      );
      if (hasExistingQuery) {
        hasExistingQuery.where[key].push(value);
      } else {
        acc.push({ model: query.model, where: { [key]: [value] } });
      }
      return acc;
    } else {
      return acc.concat(query);
    }
  }, []);

  return compactableQueries;
};

export const traverse = async (
  { model, where, order, dependencies, limit, defaultDependencies = {}, parsed = {}, depth = 1 }: RecipeItem,
  req: PartialRequest,
  callback: (ei: ExportedItem) => Promise<any>,
): Promise<void> => {
  if (model && where) {
    debug('traverse', { model, where });
    const hasIdField = models[model]['tableAttributes'].id;
    if (hasIdField) {
      if (!parsed[model]) {
        parsed[model] = new Set();
      }
    }
    let records;
    for await (const pageRecords of paginate(model, where, order, limit)) {
      records = await Promise.all(pageRecords.map(record => serialize(model, req, record)));
      records = records.filter(Boolean);

      for (const record of records) {
        if (!hasIdField) {
          await callback(record);
        } else if (hasIdField && !parsed[model]?.has(record.id)) {
          parsed[model].add(record.id);
          await callback(record);
        }
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
          else if (dep.from && record[dep.from]) {
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
      queries = compactQueries(queries);
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

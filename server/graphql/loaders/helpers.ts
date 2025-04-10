import DataLoader from 'dataloader';
import { get } from 'lodash';
import { Association, Model, ModelStatic } from 'sequelize';

import { ModelNames } from '../../models';

/** A default getter that returns item's id */
const defaultKeyGetter = <T>(item: T): number | string => item['id'];

/**
 * A newer implementation of `sortResults`.
 *
 * Sort the `results` according to `keys` order.
 *
 * @param keys: the keys to use as a reference for sorting (usually a list of ids)
 * @param results: the results as a list of entities
 * @param getKeyFromResult: a function to get the id to match keys
 * @param defaultValue: a default value used when there's no result in `results`
 */
export function sortResultsSimple<ResultType>(
  keys: readonly (string | number)[],
  results: readonly ResultType[],
  getKeyFromResult = defaultKeyGetter<ResultType>,
  defaultValue: ResultType = undefined,
): ResultType[] {
  const resultsById = {};
  results.forEach(item => {
    const id = getKeyFromResult(item);
    if (id) {
      resultsById[id] = item;
    }
  });

  return keys.map(id => resultsById[id] || defaultValue);
}

/**
 * Similar to `sortResultsSimple`, but stack items in arrays to allow storing multiple
 * results for each key.
 *
 * @param keys: the keys to use as a reference for sorting (usually a list of ids)
 * @param results: the results as a list of entities
 * @param getKeyFromResult: a function to get the id to match keys
 * @param defaultValue: a default value used when there's no result in `results`
 */
export function sortResultsArray<ResultType>(
  keys: readonly (string | number)[],
  results: readonly ResultType[],
  getKeyFromResult = defaultKeyGetter<ResultType>,
  defaultValue = [],
): ResultType[][] {
  const resultsById = {};
  results.forEach(item => {
    const id = getKeyFromResult(item);
    if (id) {
      if (resultsById[id]) {
        resultsById[id].push(item);
      } else {
        resultsById[id] = [item];
      }
    }
  });

  return keys.map(id => resultsById[id] || defaultValue);
}

type SortResults =
  | (<T>(keys: readonly (string | number)[], results: readonly T[], attribute?: string, defaultValue?: unknown) => T[])
  | (<T>(keys: readonly (string | number)[], results: readonly T[], attribute?: string, defaultValue?: []) => T[][]);
/**
 * @deprecated Prefer to use `sortResultsSimple`.
 *
 * The legacy implementation of `sortResults`. Provides a complex mechanism for using sub-fields
 * for attributes with `:` which not standard nor documented. There's also some magic happening
 * if you pass an Array as defaultValue.
 *
 * Sort the `results` according to `keys` order.
 *
 * @param keys: the keys to use as a reference for sorting (usually a list of ids)
 * @param results: the results as a list of entities
 * @param attribute: the attribute to use to get the key
 * @param defaultValue: a default value used when there's no result in `results`
 */
export const sortResults: SortResults = (keys, results, attribute = 'id', defaultValue = undefined) => {
  const resultsById = {};
  results.forEach(r => {
    let key;
    const dataValues = r['dataValues'] || r;
    if (attribute.indexOf(':') !== -1) {
      const keyComponents = [];
      attribute.split(':').forEach(attr => {
        keyComponents.push(dataValues[attr]);
      });
      key = keyComponents.join(':');
    } else {
      key = get(dataValues, attribute);
    }
    if (!key) {
      return;
    }
    // If the default value is an array
    // e.g. when we want to return all the paymentMethods for a list of collective ids.
    if (defaultValue instanceof Array) {
      resultsById[key] = resultsById[key] || [];
      resultsById[key].push(r);
    } else {
      resultsById[key] = r;
    }
  });
  return keys.map(id => resultsById[id] || defaultValue);
};

/**
 * A helper to create a dataloader for a sequelize association. This helper brings a few advantages compared to the default ones:
 * - It looks inside the model to retrieve the association is already loaded (e.g. collective.host)
 * - It sets the association on the model instances, optimizing future calls
 * - If any other model called for this loader already has
 */

export function buildLoaderForAssociation<SM extends Model, AM extends Model>(
  staticModel: ModelStatic<Model>,
  association: string,
  options: {
    filter?: (item) => boolean;
    loader?: (ids: readonly (string | number)[]) => Promise<AM[]>;
  } = {},
): DataLoader<SM, AM, string> {
  return new DataLoader(
    async (entities: SM[]): Promise<AM[]> => {
      const associationInfo = staticModel['associations'][association] as Association<SM, AM>;
      const associationsByForeignKey: Record<ForeignKeyType, SM | AM> = {};
      type ForeignKeyType = typeof associationInfo.foreignKey;

      // Cache all associations that are already loaded and list all foreign keys that need to be loaded
      for (const entity of entities) {
        const alreadyLoaded: AM | null = entity[associationInfo.as];
        const associationId: ForeignKeyType = entity[associationInfo.foreignKey];
        if (associationsByForeignKey[associationId]) {
          continue; // We already have this association
        } else if (alreadyLoaded) {
          associationsByForeignKey[associationId] = alreadyLoaded;
        } else if (associationId && (!options.filter || options.filter(entity))) {
          associationsByForeignKey[associationId] = null;
        }
      }

      // Load missing associations
      const associationNotLoadedYet = (id: ForeignKeyType): boolean => !associationsByForeignKey[id];
      const associationsIdsToLoad = Object.keys(associationsByForeignKey).filter(associationNotLoadedYet);
      if (associationsIdsToLoad.length > 0) {
        let loadedAssociations: Array<AM> = [];
        if (options.loader) {
          // If a loader is provided, use it to load the associations using the IDs we've collected
          loadedAssociations = await options.loader(associationsIdsToLoad);
        } else {
          // Otherwise fallback on making a query using the model + foreign key
          loadedAssociations = await associationInfo.target.findAll({
            where: { [associationInfo.target.primaryKeyAttribute]: associationsIdsToLoad } as any,
          });
        }

        // Add loaded associations to our `associationsByForeignKey` map
        for (const association of loadedAssociations) {
          if (association) {
            const foreignKey = association.getDataValue(associationInfo.target.primaryKeyAttribute);
            associationsByForeignKey[foreignKey] = association;
          }
        }
      }

      // Link entities to their associations
      return entities.map(entity => {
        const alreadyLoaded = entity[associationInfo.as];
        const associationId = entity[associationInfo.foreignKey];
        if (alreadyLoaded) {
          return alreadyLoaded;
        } else if (associationId && (!options.filter || options.filter(entity))) {
          entity[associationInfo.as] = associationsByForeignKey[associationId]; // Attach association to model instance
          return entity[associationInfo.as];
        } else {
          return null;
        }
      });
    },
    {
      cacheKeyFn: (entity: SM): string => entity[staticModel['primaryKeyAttribute']],
    },
  );
}

export const populateModelAssociations = async <M>(
  req: Express.Request,
  objects: M[],
  associations: Array<{ fkField: string; as?: string; modelName: ModelNames }>,
): Promise<M[]> => {
  const promises = associations.map(async ({ fkField, as: propertyKey, modelName }) => {
    const ids = objects.map(obj => obj[fkField]).filter(id => id);
    const foreignObjects = await req.loaders[modelName].byId.loadMany(ids);
    objects.forEach(obj => {
      const subObject = foreignObjects.find(s => s['id'] === obj[fkField]);
      if (subObject) {
        obj[propertyKey || modelName] = subObject;
      }
    });
  });
  await Promise.all(promises);
  return objects;
};

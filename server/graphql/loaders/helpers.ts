import DataLoader from 'dataloader';
import type { Request } from 'express';
import { get } from 'lodash';
import { Model, ModelStatic } from 'sequelize';

import models from '../../models';

/** A default getter that returns item's id */
const defaultKeyGetter = (item): number | string => item.id;

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
  getKeyFromResult = defaultKeyGetter,
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
  getKeyFromResult = defaultKeyGetter,
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
export const sortResults = (
  keys: readonly (string | number)[],
  results: readonly Record<string, unknown>[],
  attribute = 'id',
  defaultValue = undefined,
): Record<string, unknown>[] => {
  const resultsById = {};
  results.forEach(r => {
    let key;
    const dataValues = r.dataValues || r;
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
export function buildLoaderForAssociation<AssociatedModel extends Model>(
  model: ModelStatic<AssociatedModel>,
  association: string,
  options: {
    /** Will not load the association if this filter returns false */
    filter?: (item) => boolean;
    /** A custom function to load target entities by their referenced column. Useful to further optimize with loaders */
    loader?: (ids: readonly (string | number)[]) => Promise<AssociatedModel[]>;
  } = {},
) {
  return new DataLoader<Model, AssociatedModel>(
    async (entities: Model[]): Promise<AssociatedModel[]> => {
      const associationInfo = model['associations'][association];
      const associationsByForeignKey: Record<ForeignKeyType, Model> = {};
      type ForeignKeyType = typeof associationInfo.foreignKey;

      // Cache all associations that are already loaded and list all foreign keys that need to be loaded
      for (const entity of entities) {
        const alreadyLoaded: AssociatedModel | null = entity[associationInfo.as];
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
        let loadedAssociations: Model[];
        if (options.loader) {
          // If a loader is provided, use it to load the associations using the IDs we've collected
          loadedAssociations = await options.loader(associationsIdsToLoad);
        } else {
          // Otherwise fallback on making a query using the model + foreign key
          loadedAssociations = await associationInfo.target.findAll({
            where: { [associationInfo.target.primaryKeyAttribute]: associationsIdsToLoad },
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
      cacheKeyFn: (entity: AssociatedModel) => entity[model['primaryKeyAttribute']],
    },
  );
}

export const populateModelAssociations = async <M>(
  objects: M[],
  associations: Array<{ fkField: string; as?: string; modelName: keyof typeof models }>,
  { loaders },
): Promise<M[]> => {
  const promises = associations.map(async ({ fkField, as: propertyKey, modelName }) => {
    const ids = objects.map(obj => obj[fkField]).filter(id => id);
    const foreignObjects = await loaders[modelName].byId.loadMany(ids);
    objects.forEach(obj => {
      const subObject = foreignObjects.find(s => s.id === obj[fkField]);
      if (subObject) {
        obj[propertyKey || modelName] = subObject;
      }
    });
  });
  await Promise.all(promises);
  return objects;
};

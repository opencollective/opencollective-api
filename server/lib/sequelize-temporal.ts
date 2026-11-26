/**
 * Temporal tables for Sequelize: keeps a copy of every previous version of a model's rows in a
 * `<ModelName>History` table (e.g. `Collectives` -> `CollectiveHistories`).
 *
 * This is a TypeScript port of `sequelize-temporal` (https://github.com/bonaval/sequelize-temporal, v2.1.1,
 * MIT license, by greenify and contributors), vendored here because the original project is no longer
 * maintained and was pulling outdated dependencies. The behavior is meant to stay identical to the original.
 *
 * Default mode: an archive of the *previous* version of a row is stored before it gets updated or destroyed.
 * Full mode (`full: true`): every version, including the initial one, is stored after create/update/destroy/restore.
 */
import { isArray, map, omit } from 'lodash';
import type {
  CreateOptions,
  DestroyOptions,
  InstanceDestroyOptions,
  InstanceRestoreOptions,
  InstanceUpdateOptions,
  Model,
  ModelAttributeColumnOptions,
  ModelStatic,
  Sequelize,
  UpdateOptions,
} from 'sequelize';
import { DataTypes } from 'sequelize';

export type TemporalOptions = {
  /** Runs the history insert within the Sequelize hook chain. Disable for increased performance. Defaults to `true`. */
  blocking?: boolean;
  /** Stores every version (including the initial one) instead of only previous versions. Defaults to `false`. */
  full?: boolean;
  /** Does not store history when the operation is run with `silent: true`. Defaults to `false`. */
  skipIfSilent?: boolean;
  /** In `full` mode, attributes that should not be reloaded when the instance was partially loaded. Defaults to `['deletedAt']`. */
  reloadIgnoredAttributes?: string[];
};

const DEFAULT_TEMPORAL_OPTIONS: Required<TemporalOptions> = {
  blocking: true,
  full: false,
  skipIfSilent: false,
  reloadIgnoredAttributes: ['deletedAt'],
};

/** Attribute properties that must not be copied to the history model */
const EXCLUDED_ATTRIBUTE_PROPERTIES = [
  'Model',
  'unique',
  'primaryKey',
  'autoIncrement',
  'set',
  'get',
  '_modelAttribute',
] as const;

/** Model options that must not be copied to the history model */
const EXCLUDED_MODEL_OPTIONS = [
  'name',
  'tableName',
  'sequelize',
  'uniqueKeys',
  'hasPrimaryKey',
  'hooks',
  'scopes',
  'instanceMethods',
  'defaultScope',
] as const;

type HookOptions = (InstanceUpdateOptions | InstanceDestroyOptions | InstanceRestoreOptions | CreateOptions) & {
  silent?: boolean;
};

type BulkHookOptions = (UpdateOptions | DestroyOptions) & {
  individualHooks?: boolean;
  silent?: boolean;
};

/** Gives access to the Sequelize internals used by the original library */
type ModelInternals = {
  _previousDataValues?: Record<string, unknown>;
  _options: { isNewRecord?: boolean };
};

const READ_ONLY_ERROR_MESSAGE = "This is a read-only history database. You aren't allowed to modify it.";

const Temporal = <M extends ModelStatic<Model>>(
  model: M,
  sequelize: Sequelize,
  temporalOptions?: TemporalOptions,
): M => {
  const options: Required<TemporalOptions> = { ...DEFAULT_TEMPORAL_OPTIONS, ...temporalOptions };
  const historyName = `${model.name}History`;

  const historyOwnAttrs: Record<string, ModelAttributeColumnOptions> = {
    hid: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true,
      unique: true,
    },
    archivedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  };

  const attributes = model.getAttributes() as Record<string, ModelAttributeColumnOptions & { fieldName?: string }>;
  const historyAttributes: Record<string, ModelAttributeColumnOptions> = {};
  for (const [name, attribute] of Object.entries(attributes)) {
    const historyAttribute = omit(attribute, EXCLUDED_ATTRIBUTE_PROPERTIES) as ModelAttributeColumnOptions & {
      fieldName?: string;
    };
    // Remove the "NOW" defaultValue for the default timestamps: we want to save them, but just as a copy
    // from the main record.
    if (historyAttribute.fieldName === 'createdAt' || historyAttribute.fieldName === 'updatedAt') {
      historyAttribute.type = DataTypes.DATE;
    }
    historyAttributes[name] = historyAttribute;
  }
  Object.assign(historyAttributes, historyOwnAttrs);

  const historyOptions = { ...omit(model.options, EXCLUDED_MODEL_OPTIONS), timestamps: false };

  // Unique indexes don't make sense in the history table, since the same record can be archived multiple times
  if (isArray(historyOptions.indexes)) {
    historyOptions.indexes = historyOptions.indexes.filter(index => !index.unique && index.type !== 'UNIQUE');
  }

  const modelHistory = sequelize.define(historyName, historyAttributes, historyOptions);

  const isVirtual = (attribute: string): boolean => attributes[attribute].type instanceof DataTypes.VIRTUAL;

  const getDataValues = async (obj: Model, hookOptions: HookOptions): Promise<Record<string, unknown>> => {
    const internals = obj as unknown as ModelInternals;
    if (!options.full) {
      return internals._previousDataValues || obj.dataValues;
    }

    // This is the initial record of a new entity, just use the attributes that were used.
    if (internals._options.isNewRecord) {
      return obj.dataValues;
    }

    // In 'full' mode, it's important that we are able to save a History version even though the caller initially
    // fetched a partial instance. We do so at the cost of an extra SELECT to get up-to-date values (in 'full' mode
    // we are using afterX hooks, so this works). `Model.reload()` merges the newly fetched values in `dataValues`.
    const attributesToReload = Object.keys(attributes).filter(
      attribute =>
        !options.reloadIgnoredAttributes.includes(attribute) && !isVirtual(attribute) && !(attribute in obj.dataValues),
    );

    if (attributesToReload.length > 0) {
      await obj.reload({
        attributes: attributesToReload,
        transaction: hookOptions.transaction,
        paranoid: false,
        include: null,
      });
    }

    return obj.dataValues;
  };

  const insertHook = async (obj: Model, hookOptions: HookOptions): Promise<void> => {
    if (hookOptions.silent && options.skipIfSilent) {
      return;
    }

    const historyRecord = getDataValues(obj, hookOptions).then(dataValues =>
      modelHistory.create(dataValues, { transaction: hookOptions.transaction }),
    );

    if (options.blocking) {
      await historyRecord;
    }
  };

  const insertBulkHook = async (hookOptions: BulkHookOptions): Promise<void> => {
    if (hookOptions.individualHooks) {
      return;
    } else if (hookOptions.silent && options.skipIfSilent) {
      return;
    }

    const queryAll = model
      .findAll({ where: hookOptions.where, transaction: hookOptions.transaction })
      .then(hits => modelHistory.bulkCreate(map(hits, 'dataValues'), { transaction: hookOptions.transaction }));

    if (options.blocking) {
      await queryAll;
    }
  };

  // All hooks just create a copy
  if (options.full) {
    model.addHook('afterCreate', insertHook);
    model.addHook('afterUpdate', insertHook);
    model.addHook('afterDestroy', insertHook);
    model.addHook('afterRestore', insertHook);
  } else {
    model.addHook('beforeUpdate', insertHook);
    model.addHook('beforeDestroy', insertHook);
  }

  model.addHook('beforeBulkUpdate', insertBulkHook);
  model.addHook('beforeBulkDestroy', insertBulkHook);

  const readOnlyHook = (): never => {
    throw new Error(READ_ONLY_ERROR_MESSAGE);
  };

  modelHistory.addHook('beforeUpdate', readOnlyHook);
  modelHistory.addHook('beforeDestroy', readOnlyHook);

  return model;
};

export default Temporal;

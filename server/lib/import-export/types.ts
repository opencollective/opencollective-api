import type { Order, WhereOptions } from 'sequelize';

import type { ModelNames } from '../../models';

/**
 * A serialized record of the export: all the model attributes plus the model name and its id.
 */
export type ExportedItem = Record<string, unknown> & { model: ModelNames; id: number | string };

/**
 * A "where" clause: either a static Sequelize where clause, or a function computing one from a parent record.
 */
type RecipeItemWhere = WhereOptions | ((record: ExportedItem) => WhereOptions);

export type RecipeItem = {
  model?: ModelNames;
  where?: RecipeItemWhere;
  order?: Order;
  dependencies?: Array<Omit<RecipeItem, 'req'>>;
  defaultDependencies?: Record<string, RecipeItem>;
  on?: string;
  from?: string;
  limit?: number;
  parsed?: Record<string, Set<number | string>>;
  depth?: number;
};

export { ModelNames };

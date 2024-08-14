import { loaders } from '../../graphql/loaders';
import type { ModelNames, User } from '../../models';

/**
 * A req object that only contains the necessary fields for the import/export process.
 */
export type PartialRequest = {
  remoteUser: User;
  loaders: ReturnType<typeof loaders>;
};

export type RecipeItem = {
  model?: ModelNames;
  where?: Record<string, any>;
  order?: Record<string, any>;
  dependencies?: Array<Omit<RecipeItem, 'req'>>;
  defaultDependencies?: Record<string, RecipeItem>;
  on?: string;
  from?: string;
  limit?: number;
  parsed?: Record<string, Set<number | string>>;
  depth?: number;
};

export { ModelNames };

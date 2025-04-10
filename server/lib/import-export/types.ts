import type { ModelNames } from '../../models';

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

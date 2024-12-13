import { MappingTypeMapping, QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types';
import { ModelStatic } from 'sequelize';

import { Model } from '../../../lib/sequelize';
import { ModelType } from '../../../models';
import { ElasticSearchIndexName } from '../constants';

type ElasticSearchModelPermissions = {
  /** Either public, forbidden or an array of conditions (interpreted as OR) */
  default: QueryDslQueryContainer | 'PUBLIC' | 'FORBIDDEN';
  /** Additional per-field conditions */
  fields?: Record<string, QueryDslQueryContainer | 'FORBIDDEN'>;
};

export type FindEntriesToIndexOptions = {
  offset?: number;
  limit?: number;
  fromDate?: Date;
  maxId?: number;
  ids?: number[];
  relatedToCollectiveIds?: number[];
};

export type ElasticSearchFieldWeight = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface ElasticSearchModelAdapter {
  readonly index: ElasticSearchIndexName;
  readonly mappings: MappingTypeMapping;
  readonly weights: Partial<Record<keyof (typeof this)['mappings']['properties'], ElasticSearchFieldWeight>>;

  getModel(): ModelStatic<Model>;

  /** Returns the attributes that `mapModelInstanceToDocument` needs to build the document */
  findEntriesToIndex(options?: FindEntriesToIndexOptions): Promise<Array<InstanceType<ModelType>>>;

  /** Maps a model instance to an ElasticSearch document */
  mapModelInstanceToDocument(
    instance: InstanceType<ModelType>,
  ): Record<keyof (typeof this)['mappings']['properties'], unknown>;

  /** Returns the conditions for the permissions */
  getIndexPermissions(adminOfAccountIds: number[]): ElasticSearchModelPermissions;
}

import { IndicesIndexSettings, MappingTypeMapping, QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types';
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

export interface ElasticSearchModelAdapter {
  readonly index: ElasticSearchIndexName;
  readonly mappings: MappingTypeMapping;
  readonly settings?: IndicesIndexSettings;

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

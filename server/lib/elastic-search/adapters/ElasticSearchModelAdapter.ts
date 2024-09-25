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

export interface ElasticSearchModelAdapter {
  readonly model: ModelStatic<Model>;
  readonly index: ElasticSearchIndexName;
  readonly mappings: MappingTypeMapping;
  readonly settings?: IndicesIndexSettings;

  /** Returns the attributes that `mapModelInstanceToDocument` needs to build the document */
  findEntriesToIndex(
    offset: number,
    limit: number,
    options: { fromDate: Date; firstReturnedId: number },
  ): Promise<Array<InstanceType<ModelType>>>;

  /** Maps a model instance to an ElasticSearch document */
  mapModelInstanceToDocument(
    instance: InstanceType<ModelType>,
  ): Record<keyof (typeof this)['mappings']['properties'], unknown>;

  /** Returns the conditions for the permissions */
  getIndexPermissions(adminOfAccountIds: number[]): ElasticSearchModelPermissions;
}

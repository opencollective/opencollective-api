import { TypeMapping } from '@opensearch-project/opensearch/api/_types/_common.mapping';
import { QueryContainer } from '@opensearch-project/opensearch/api/_types/_common.query_dsl';
import { ModelStatic } from 'sequelize';

import { ModelType } from '../../../models';
import { Model } from '../../sequelize';
import { OpenSearchIndexName } from '../constants';

type OpenSearchModelPermissions = {
  /** Either public, forbidden or an array of conditions (interpreted as OR) */
  default: QueryContainer | 'PUBLIC' | 'FORBIDDEN';
  /** Additional per-field conditions */
  fields?: Record<string, QueryContainer | 'FORBIDDEN'>;
};

export type FindEntriesToIndexOptions = {
  offset?: number;
  limit?: number;
  fromDate?: Date;
  maxId?: number;
  ids?: number[];
  relatedToCollectiveIds?: number[];
};

export type OpenSearchFieldWeight = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface OpenSearchModelAdapter {
  readonly index: OpenSearchIndexName;
  readonly mappings: TypeMapping;
  readonly weights: Partial<Record<keyof (typeof this)['mappings']['properties'], OpenSearchFieldWeight>>;

  getModel(): ModelStatic<Model>;

  /** Returns the attributes that `mapModelInstanceToDocument` needs to build the document */
  findEntriesToIndex(options?: FindEntriesToIndexOptions): Promise<Array<InstanceType<ModelType>>>;

  /** Maps a model instance to an OpenSearch document */
  mapModelInstanceToDocument(
    instance: InstanceType<ModelType>,
  ): Record<keyof (typeof this)['mappings']['properties'], unknown>;

  /** Returns the conditions for the permissions */
  getIndexPermissions(adminOfAccountIds: number[]): OpenSearchModelPermissions;
}

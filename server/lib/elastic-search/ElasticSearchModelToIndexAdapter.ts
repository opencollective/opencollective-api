import { IndicesIndexSettings, MappingTypeMapping } from '@elastic/elasticsearch/lib/api/types';
import { Includeable } from 'sequelize';

import { ModelType } from '../../models';

import { ElasticSearchIndexName } from './const';

export interface ElasticSearchModelToIndexAdapter {
  readonly model: ModelType;
  readonly index: ElasticSearchIndexName;
  readonly mappings: MappingTypeMapping;
  readonly settings?: IndicesIndexSettings;

  /** Returns the attributes that `mapModelInstanceToDocument` needs to build the document */
  getAttributesForFindAll(): string[];
  getIncludeForFindAll?(): Includeable[];
  /** Maps a model instance to an ElasticSearch document */
  mapModelInstanceToDocument(
    instance: (typeof this)['model'],
  ): Record<keyof (typeof this)['mappings']['properties'], unknown>;
}

import { IndicesIndexSettings, MappingTypeMapping } from '@elastic/elasticsearch/lib/api/types';

import { ModelType } from '../../models';

import { ElasticSearchIndexName } from './const';

export interface ElasticSearchModelToIndexAdapter {
  readonly model: ModelType;
  readonly mappings: MappingTypeMapping;
  readonly index: ElasticSearchIndexName;
  readonly settings?: IndicesIndexSettings;

  mapModelInstanceToDocument(
    instance: (typeof this)['model'],
  ): Promise<Record<keyof (typeof this)['mappings']['properties'], unknown>>;
}

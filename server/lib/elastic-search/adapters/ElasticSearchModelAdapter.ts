import { IndicesIndexSettings, MappingTypeMapping } from '@elastic/elasticsearch/lib/api/types';

import { ModelType } from '../../../models';
import { ElasticSearchIndexName } from '../constants';

export interface ElasticSearchModelAdapter<TIndexName extends ElasticSearchIndexName, TModel extends ModelType> {
  readonly model: TModel;
  readonly index: TIndexName;
  readonly mappings: MappingTypeMapping;
  readonly settings?: IndicesIndexSettings;

  /** Returns the attributes that `mapModelInstanceToDocument` needs to build the document */
  findEntriesToIndex(
    offset: number,
    limit: number,
    options: { fromDate: Date; firstReturnedId: number },
  ): Promise<Array<InstanceType<TModel>>>;

  /** Maps a model instance to an ElasticSearch document */
  mapModelInstanceToDocument(
    instance: InstanceType<TModel>,
  ): Record<keyof (typeof this)['mappings']['properties'], unknown>;
}

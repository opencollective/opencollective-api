import { IndicesIndexSettings, MappingTypeMapping } from '@elastic/elasticsearch/lib/api/types';
import { ModelStatic } from 'sequelize';

import { Model } from '../../../lib/sequelize';
import { ModelType } from '../../../models';
import { ElasticSearchIndexName } from '../constants';

export interface ElasticSearchModelAdapter {
  readonly model: ModelStatic<Model>;
  readonly index: ElasticSearchIndexName;
  readonly mappings: MappingTypeMapping;
  readonly settings?: IndicesIndexSettings;
  readonly permissions: {
    default: 'PUBLIC' | readonly ('HOST_ADMIN' | 'ACCOUNT_ADMIN' | 'FROM_ACCOUNT_ADMIN')[];
    fields?: Record<string, readonly ('HOST_ADMIN' | 'ACCOUNT_ADMIN' | 'FROM_ACCOUNT_ADMIN')[]>;
  };

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
}

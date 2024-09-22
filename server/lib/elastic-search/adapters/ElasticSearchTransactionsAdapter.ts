import { omit } from 'lodash';
import { Op } from 'sequelize';

import models from '../../../models';
import { ElasticSearchIndexName } from '../constants';

import { ElasticSearchModelToIndexAdapter } from './ElasticSearchModelToIndexAdapter';

export class ElasticSearchTransactionsAdapter
  implements ElasticSearchModelToIndexAdapter<ElasticSearchIndexName.TRANSACTIONS, typeof models.Transaction>
{
  public readonly model = models.Transaction;
  public readonly index = ElasticSearchIndexName.TRANSACTIONS;
  public readonly mappings = {
    properties: {
      id: { type: 'keyword' },
      type: { type: 'keyword' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
      kind: { type: 'keyword' },
      description: { type: 'text' },
      uuid: { type: 'keyword' },
      // Relationships
      CollectiveId: { type: 'keyword' },
      FromCollectiveId: { type: 'keyword' },
      HostCollectiveId: { type: 'keyword' },
      CreatedByUserId: { type: 'keyword' },
      // Special fields
      merchantId: { type: 'keyword' },
    },
  } as const;

  public findEntriesToIndex(offset: number, limit: number, options: { fromDate: Date; firstReturnedId: number }) {
    return models.Transaction.findAll({
      attributes: omit(Object.keys(this.mappings.properties), ['merchantId']),
      order: [['id', 'DESC']],
      offset,
      limit,
      where: {
        ...(options.fromDate ? { updatedAt: options.fromDate } : null),
        ...(options.firstReturnedId ? { id: { [Op.lte]: options.firstReturnedId } } : null),
      },
    });
  }

  public mapModelInstanceToDocument(
    instance: InstanceType<typeof models.Transaction>,
  ): Record<keyof (typeof this.mappings)['properties'], unknown> {
    return {
      id: instance.id,
      uuid: instance.uuid,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      type: instance.type,
      kind: instance.kind,
      description: instance.description,
      CollectiveId: instance.CollectiveId,
      FromCollectiveId: instance.FromCollectiveId,
      CreatedByUserId: instance.CreatedByUserId,
      HostCollectiveId: instance.HostCollectiveId,
      merchantId: instance.merchantId,
    };
  }
}

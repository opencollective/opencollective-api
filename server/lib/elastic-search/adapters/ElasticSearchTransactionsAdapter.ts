import { omit } from 'lodash';
import { Op } from 'sequelize';

import models from '../../../models';
import { ElasticSearchIndexName } from '../constants';

import { ElasticSearchModelAdapter, FindEntriesToIndexOptions } from './ElasticSearchModelAdapter';

export class ElasticSearchTransactionsAdapter implements ElasticSearchModelAdapter {
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
      TransactionGroup: { type: 'keyword' },
      // Relationships
      CollectiveId: { type: 'keyword' },
      FromCollectiveId: { type: 'keyword' },
      HostCollectiveId: { type: 'keyword' },
      // Special fields
      merchantId: { type: 'keyword' },
    },
  } as const;

  public getModel() {
    return models.Transaction;
  }

  public findEntriesToIndex(options: FindEntriesToIndexOptions = {}) {
    return models.Transaction.findAll({
      attributes: omit(Object.keys(this.mappings.properties), ['merchantId']),
      order: [['id', 'DESC']],
      limit: options.limit,
      offset: options.offset,
      where: {
        ...(options.fromDate ? { updatedAt: options.fromDate } : null),
        ...(options.maxId ? { id: { [Op.lte]: options.maxId } } : null),
        ...(options.ids?.length ? { id: options.ids } : null),
        ...(options.relatedToCollectiveIds?.length
          ? {
              [Op.or]: [
                { CollectiveId: options.relatedToCollectiveIds },
                { FromCollectiveId: options.relatedToCollectiveIds },
                { HostCollectiveId: options.relatedToCollectiveIds },
              ],
            }
          : null),
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
      HostCollectiveId: instance.HostCollectiveId,
      TransactionGroup: instance.TransactionGroup,
      merchantId: instance.merchantId,
    };
  }

  public getIndexPermissions(adminOfAccountIds: number[]) {
    return {
      default: 'PUBLIC' as const,
      fields: {
        merchantId: !adminOfAccountIds.length
          ? ('FORBIDDEN' as const)
          : { terms: { HostCollectiveId: adminOfAccountIds } },
      },
    };
  }
}

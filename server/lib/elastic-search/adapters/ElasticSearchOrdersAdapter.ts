import { omit } from 'lodash';
import { Op } from 'sequelize';

import models, { Subscription } from '../../../models';
import { ElasticSearchIndexName } from '../constants';

import { ElasticSearchModelAdapter, FindEntriesToIndexOptions } from './ElasticSearchModelAdapter';

export class ElasticSearchOrdersAdapter implements ElasticSearchModelAdapter {
  public readonly index = ElasticSearchIndexName.ORDERS;
  public readonly mappings = {
    properties: {
      id: { type: 'keyword' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
      description: { type: 'keyword' },
      // Relationships
      CollectiveId: { type: 'keyword' },
      FromCollectiveId: { type: 'keyword' },
      CreatedByUserId: { type: 'keyword' },
      // Special fields
      HostCollectiveId: { type: 'keyword' },
      ParentCollectiveId: { type: 'keyword' },
      paypalSubscriptionId: { type: 'keyword' },
    },
  } as const;

  public getModel() {
    return models.Order;
  }

  public findEntriesToIndex(options: FindEntriesToIndexOptions = {}) {
    return models.Order.findAll({
      attributes: omit(Object.keys(this.mappings.properties), ['HostCollectiveId', 'ParentCollectiveId']),
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
              ],
            }
          : null),
      },
      include: [
        {
          association: 'collective',
          required: true,
          attributes: ['isActive', 'HostCollectiveId', 'ParentCollectiveId'],
        },
        {
          model: Subscription,
          required: false,
          attributes: ['paypalSubscriptionId'],
        },
      ],
    });
  }

  public mapModelInstanceToDocument(
    instance: InstanceType<typeof models.Order>,
  ): Record<keyof (typeof this.mappings)['properties'], unknown> {
    return {
      id: instance.id,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      description: instance.description,
      CollectiveId: instance.CollectiveId,
      FromCollectiveId: instance.FromCollectiveId,
      HostCollectiveId: !instance.collective.isActive ? null : instance.collective.HostCollectiveId,
      ParentCollectiveId: instance.collective.ParentCollectiveId,
      CreatedByUserId: instance.CreatedByUserId,
      paypalSubscriptionId: instance.Subscription?.paypalSubscriptionId,
    };
  }

  public getIndexPermissions(adminOfAccountIds: number[]) {
    /* eslint-disable camelcase */
    return {
      default: 'PUBLIC' as const,
      fields: {
        paypalSubscriptionId: {
          terms: { HostCollectiveId: adminOfAccountIds },
        },
        CreatedByUserId: {
          terms: { HostCollectiveId: adminOfAccountIds },
        },
      },
    };
    /* eslint-enable camelcase */
  }
}

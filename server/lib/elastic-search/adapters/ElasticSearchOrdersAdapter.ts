import { omit } from 'lodash';
import { Op } from 'sequelize';

import models from '../../../models';
import { ElasticSearchIndexName } from '../constants';

import { ElasticSearchModelAdapter } from './ElasticSearchModelAdapter';

export class ElasticSearchOrdersAdapter implements ElasticSearchModelAdapter {
  public readonly model = models.Order;
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
      // Special fields
      HostCollectiveId: { type: 'keyword' },
      ParentCollectiveId: { type: 'keyword' },
      paypalSubscriptionId: { type: 'keyword' },
    },
  } as const;

  public findEntriesToIndex(
    options: {
      offset?: number;
      limit?: number;
      fromDate?: Date;
      maxId?: number;
      ids?: number[];
    } = {},
  ) {
    return models.Order.findAll({
      attributes: omit(Object.keys(this.mappings.properties), ['HostCollectiveId', 'ParentCollectiveId']),
      order: [['id', 'DESC']],
      limit: options.limit,
      offset: options.offset,
      where: {
        ...(options.fromDate ? { updatedAt: options.fromDate } : null),
        ...(options.maxId ? { id: { [Op.lte]: options.maxId } } : null),
        ...(options.ids?.length ? { id: { [Op.in]: options.ids } } : null),
      },
      include: [
        {
          association: 'collective',
          required: true,
          attributes: ['HostCollectiveId', 'ParentCollectiveId'],
        },
        {
          model: models.Subscription,
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
      HostCollectiveId: instance.collective.HostCollectiveId,
      ParentCollectiveId: instance.collective.ParentCollectiveId,
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
      },
    };
    /* eslint-enable camelcase */
  }
}

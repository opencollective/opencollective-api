import { omit } from 'lodash';
import { Op } from 'sequelize';

import models, { Subscription } from '../../../models';
import { OpenSearchIndexName } from '../constants';

import { FindEntriesToIndexOptions, OpenSearchFieldWeight, OpenSearchModelAdapter } from './OpenSearchModelAdapter';

export class OpenSearchOrdersAdapter implements OpenSearchModelAdapter {
  public readonly index = OpenSearchIndexName.ORDERS;
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

  public readonly weights: Partial<Record<keyof (typeof this.mappings)['properties'], OpenSearchFieldWeight>> = {
    paypalSubscriptionId: 10,
    id: 10,
    description: 5,
    // Ignored fields
    CollectiveId: 0,
    FromCollectiveId: 0,
    HostCollectiveId: 0,
    ParentCollectiveId: 0,
    CreatedByUserId: 0,
    createdAt: 0,
    updatedAt: 0,
  };

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
  }
}

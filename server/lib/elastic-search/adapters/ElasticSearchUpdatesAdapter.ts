import { omit } from 'lodash';
import { Op } from 'sequelize';

import models from '../../../models';
import { ElasticSearchIndexName } from '../constants';

import { ElasticSearchModelAdapter } from './ElasticSearchModelAdapter';

export class ElasticSearchUpdatesAdapter
  implements ElasticSearchModelAdapter<ElasticSearchIndexName.UPDATES, typeof models.Update>
{
  public readonly model = models.Update;
  public readonly index = ElasticSearchIndexName.UPDATES;
  public readonly mappings = {
    properties: {
      id: { type: 'keyword' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
      html: { type: 'text' },
      // Relationships
      CollectiveId: { type: 'keyword' },
      FromCollectiveId: { type: 'keyword' },
      CreatedByUserId: { type: 'keyword' },
      // Special fields
      ParentCollectiveId: { type: 'keyword' },
      HostCollectiveId: { type: 'keyword' },
    },
  } as const;

  public findEntriesToIndex(offset: number, limit: number, options: { fromDate: Date; firstReturnedId: number }) {
    return models.Update.findAll({
      attributes: omit(Object.keys(this.mappings.properties), ['HostCollectiveId', 'ParentCollectiveId']),
      order: [['id', 'DESC']],
      offset,
      limit,
      where: {
        ...(options.fromDate ? { updatedAt: options.fromDate } : null),
        ...(options.firstReturnedId ? { id: { [Op.lte]: options.firstReturnedId } } : null),
      },
      include: [
        {
          association: 'collective',
          required: true,
          attributes: ['HostCollectiveId', 'ParentCollectiveId'],
        },
      ],
    });
  }

  public mapModelInstanceToDocument(
    instance: InstanceType<typeof models.Update>,
  ): Record<keyof (typeof this.mappings)['properties'], unknown> {
    return {
      id: instance.id,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      html: instance.html,
      CollectiveId: instance.CollectiveId,
      FromCollectiveId: instance.FromCollectiveId,
      CreatedByUserId: instance.CreatedByUserId,
      HostCollectiveId: instance.collective.HostCollectiveId,
      ParentCollectiveId: instance.collective.ParentCollectiveId,
    };
  }
}

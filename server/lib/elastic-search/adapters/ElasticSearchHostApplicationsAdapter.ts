import { omit } from 'lodash';
import { Op } from 'sequelize';

import models from '../../../models';
import { ElasticSearchIndexName } from '../constants';

import { ElasticSearchModelAdapter } from './ElasticSearchModelAdapter';

export class ElasticSearchHostApplicationsAdapter
  implements ElasticSearchModelAdapter<ElasticSearchIndexName.HOST_APPLICATIONS, typeof models.HostApplication>
{
  public readonly model = models.HostApplication;
  public readonly index = ElasticSearchIndexName.HOST_APPLICATIONS;
  public readonly mappings = {
    properties: {
      id: { type: 'keyword' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
      message: { type: 'text' },
      // Relationships
      CollectiveId: { type: 'keyword' },
      HostCollectiveId: { type: 'keyword' },
      CreatedByUserId: { type: 'keyword' },
      // Special fields
      ParentCollectiveId: { type: 'keyword' },
    },
  } as const;

  public findEntriesToIndex(offset: number, limit: number, options: { fromDate: Date; firstReturnedId: number }) {
    return models.HostApplication.findAll({
      attributes: omit(Object.keys(this.mappings.properties), ['ParentCollectiveId']),
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
          attributes: ['ParentCollectiveId'],
        },
      ],
    });
  }

  public mapModelInstanceToDocument(
    instance: InstanceType<typeof models.HostApplication>,
  ): Record<keyof (typeof this.mappings)['properties'], unknown> {
    return {
      id: instance.id,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      CollectiveId: instance.CollectiveId,
      HostCollectiveId: instance.HostCollectiveId,
      CreatedByUserId: instance.CreatedByUserId,
      message: instance.message,
      ParentCollectiveId: instance.collective.ParentCollectiveId,
    };
  }
}

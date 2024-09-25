import { omit } from 'lodash';
import { Op } from 'sequelize';

import models from '../../../models';
import { stripHTMLOrEmpty } from '../../sanitize-html';
import { ElasticSearchIndexName } from '../constants';

import { ElasticSearchModelAdapter } from './ElasticSearchModelAdapter';

export class ElasticSearchTiersAdapter implements ElasticSearchModelAdapter {
  public readonly model = models.Tier;
  public readonly index = ElasticSearchIndexName.TIERS;
  public readonly mappings = {
    properties: {
      id: { type: 'keyword' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
      type: { type: 'keyword' },
      name: { type: 'text' },
      slug: { type: 'keyword' },
      description: { type: 'text' },
      longDescription: { type: 'text' },
      // Relationships
      CollectiveId: { type: 'keyword' },
      // Special fields
      HostCollectiveId: { type: 'keyword' },
      ParentCollectiveId: { type: 'keyword' },
    },
  } as const;

  public findEntriesToIndex(offset: number, limit: number, options: { fromDate: Date; firstReturnedId: number }) {
    return models.Tier.findAll({
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
          association: 'Collective',
          required: true,
          attributes: ['HostCollectiveId', 'ParentCollectiveId'],
        },
      ],
    });
  }

  public mapModelInstanceToDocument(
    instance: InstanceType<typeof models.Tier>,
  ): Record<keyof (typeof this.mappings)['properties'], unknown> {
    return {
      id: instance.id,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      type: instance.type,
      name: instance.name,
      slug: instance.slug,
      description: instance.description,
      longDescription: stripHTMLOrEmpty(instance.longDescription),
      CollectiveId: instance.CollectiveId,
      HostCollectiveId: instance.Collective.HostCollectiveId,
      ParentCollectiveId: instance.Collective.ParentCollectiveId,
    };
  }

  public getIndexPermissions(/* _adminOfAccountIds: number[]*/) {
    /* eslint-disable camelcase */
    return { default: 'PUBLIC' as const };
    /* eslint-enable camelcase */
  }
}

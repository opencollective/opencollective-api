import { Includeable } from 'sequelize';

import models from '../../../models';
import { ElasticSearchIndexName } from '../const';
import { ElasticSearchModelToIndexAdapter } from '../ElasticSearchModelToIndexAdapter';

export class ElasticSearchCommentsAdapter implements ElasticSearchModelToIndexAdapter {
  public readonly model = models.Comment;
  public readonly index = ElasticSearchIndexName.COMMENTS;
  public readonly mappings = {
    properties: {
      id: { type: 'keyword' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
      html: { type: 'text' },
      // Relationships
      CollectiveId: { type: 'keyword' },
      ParentCollectiveId: { type: 'keyword' },
      HostCollectiveId: { type: 'keyword' },
      FromCollectiveId: { type: 'keyword' },
      CreatedByUserId: { type: 'keyword' },
    },
  } as const;

  public getAttributesForFindAll(): string[] {
    return Object.keys(this.mappings.properties);
  }

  public getIncludeForFindAll(): Includeable[] {
    return [
      {
        association: 'collective',
        required: true,
        attributes: ['HostCollectiveId', 'ParentCollectiveId'],
      },
    ];
  }

  public mapModelInstanceToDocument(
    instance: InstanceType<typeof models.Comment>,
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

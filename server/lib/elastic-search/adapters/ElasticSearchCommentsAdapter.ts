import { QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types';
import { omit } from 'lodash';
import { Op } from 'sequelize';

import models from '../../../models';
import { CommentType } from '../../../models/Comment';
import { stripHTMLOrEmpty } from '../../sanitize-html';
import { ElasticSearchIndexName } from '../constants';

import { ElasticSearchModelAdapter } from './ElasticSearchModelAdapter';

export class ElasticSearchCommentsAdapter implements ElasticSearchModelAdapter {
  public readonly model = models.Comment;
  public readonly index = ElasticSearchIndexName.COMMENTS;
  public readonly mappings = {
    properties: {
      id: { type: 'keyword' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
      html: { type: 'text' },
      type: { type: 'keyword' },
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
    return models.Comment.findAll({
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
    instance: InstanceType<typeof models.Comment>,
  ): Record<keyof (typeof this.mappings)['properties'], unknown> {
    return {
      id: instance.id,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      html: stripHTMLOrEmpty(instance.html),
      type: instance.type,
      CollectiveId: instance.CollectiveId,
      FromCollectiveId: instance.FromCollectiveId,
      CreatedByUserId: instance.CreatedByUserId,
      HostCollectiveId: instance.collective.HostCollectiveId,
      ParentCollectiveId: instance.collective.ParentCollectiveId,
    };
  }

  public getIndexPermissions(adminOfAccountIds: number[]) {
    /* eslint-disable camelcase */
    if (!adminOfAccountIds.length) {
      return { default: 'FORBIDDEN' as const };
    }

    return {
      default: {
        bool: {
          minimum_should_match: 1,
          should: [
            {
              terms: { HostCollectiveId: adminOfAccountIds },
            },
            {
              bool: {
                filter: [{ term: { type: CommentType.COMMENT } }, { terms: { CollectiveId: adminOfAccountIds } }],
              },
            },
            {
              bool: {
                filter: [{ term: { type: CommentType.COMMENT } }, { terms: { FromCollectiveId: adminOfAccountIds } }],
              },
            },
            {
              bool: {
                filter: [{ term: { type: CommentType.COMMENT } }, { terms: { ParentCollectiveId: adminOfAccountIds } }],
              },
            },
          ],
        },
      } satisfies QueryDslQueryContainer,
    };
    /* eslint-enable camelcase */
  }
}

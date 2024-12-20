import { QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types';
import { omit } from 'lodash';
import { Op } from 'sequelize';

import models from '../../../models';
import { CommentType } from '../../../models/Comment';
import { stripHTMLOrEmpty } from '../../sanitize-html';
import { ElasticSearchIndexName } from '../constants';

import {
  ElasticSearchFieldWeight,
  ElasticSearchModelAdapter,
  FindEntriesToIndexOptions,
} from './ElasticSearchModelAdapter';

export class ElasticSearchCommentsAdapter implements ElasticSearchModelAdapter {
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

  public getModel() {
    return models.Comment;
  }

  public readonly weights: Partial<Record<keyof (typeof this.mappings)['properties'], ElasticSearchFieldWeight>> = {
    html: 10,
    // Ignored fields
    id: 0,
    CollectiveId: 0,
    FromCollectiveId: 0,
    CreatedByUserId: 0,
    ParentCollectiveId: 0,
    HostCollectiveId: 0,
    createdAt: 0,
    updatedAt: 0,
    type: 0,
  };

  public findEntriesToIndex(options: FindEntriesToIndexOptions = {}) {
    return models.Comment.findAll({
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
          association: 'expense',
          required: false,
          attributes: ['HostCollectiveId'],
        },
        {
          association: 'hostApplication',
          required: false,
          attributes: ['HostCollectiveId'],
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
      ParentCollectiveId: instance.collective.ParentCollectiveId,
      HostCollectiveId:
        instance.expense?.HostCollectiveId ??
        instance.hostApplication?.HostCollectiveId ??
        (!instance.collective.isActive ? null : instance.collective.HostCollectiveId),
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

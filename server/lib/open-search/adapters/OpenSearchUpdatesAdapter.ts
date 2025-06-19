import { omit } from 'lodash';
import { Op } from 'sequelize';

import models from '../../../models';
import { stripHTMLOrEmpty } from '../../sanitize-html';
import { OpenSearchIndexName } from '../constants';

import { FindEntriesToIndexOptions, OpenSearchFieldWeight, OpenSearchModelAdapter } from './OpenSearchModelAdapter';

export class OpenSearchUpdatesAdapter implements OpenSearchModelAdapter {
  public readonly index = OpenSearchIndexName.UPDATES;
  public readonly mappings = {
    properties: {
      id: { type: 'keyword' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
      publishedAt: { type: 'date' },
      html: { type: 'text' },
      title: { type: 'text' },
      slug: { type: 'keyword' },
      isPrivate: { type: 'boolean' },
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
    return models.Update;
  }

  public readonly weights: Partial<Record<keyof (typeof this.mappings)['properties'], OpenSearchFieldWeight>> = {
    html: 5,
    title: 7,
    slug: 8,
    // Ignored fields
    id: 0,
    CollectiveId: 0,
    FromCollectiveId: 0,
    CreatedByUserId: 0,
    createdAt: 0,
    updatedAt: 0,
    publishedAt: 0,
    isPrivate: 0,
    ParentCollectiveId: 0,
    HostCollectiveId: 0,
  };

  public findEntriesToIndex(options: FindEntriesToIndexOptions = {}) {
    return models.Update.findAll({
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
          where: { data: { hideFromSearch: { [Op.not]: true } } },
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
      isPrivate: instance.isPrivate,
      publishedAt: instance.publishedAt,
      slug: instance.slug,
      html: stripHTMLOrEmpty(instance.html),
      title: instance.title,
      CollectiveId: instance.CollectiveId,
      FromCollectiveId: instance.FromCollectiveId,
      CreatedByUserId: instance.CreatedByUserId,
      HostCollectiveId: !instance.collective.isActive ? null : instance.collective.HostCollectiveId,
      ParentCollectiveId: instance.collective.ParentCollectiveId,
    };
  }

  public getIndexPermissions(adminOfAccountIds: number[]) {
    /* eslint-disable camelcase */
    return {
      default: {
        bool: {
          minimum_should_match: 1,
          should: [
            { bool: { must: [{ term: { isPrivate: false } }, { exists: { field: 'publishedAt' } }] } },
            { terms: { HostCollectiveId: adminOfAccountIds } },
            { terms: { CollectiveId: adminOfAccountIds } },
            { terms: { ParentCollectiveId: adminOfAccountIds } },
          ],
        },
      },
    };
    /* eslint-enable camelcase */
  }
}

import { omit } from 'lodash';
import { Op } from 'sequelize';

import models from '../../../models';
import { stripHTMLOrEmpty } from '../../sanitize-html';
import { OpenSearchIndexName } from '../constants';

import { FindEntriesToIndexOptions, OpenSearchFieldWeight, OpenSearchModelAdapter } from './OpenSearchModelAdapter';

export class OpenSearchTiersAdapter implements OpenSearchModelAdapter {
  public readonly index = OpenSearchIndexName.TIERS;
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

  public getModel() {
    return models.Tier;
  }

  public readonly weights: Partial<Record<keyof (typeof this.mappings)['properties'], OpenSearchFieldWeight>> = {
    description: 5,
    name: 5,
    longDescription: 5,
    slug: 7,
    id: 1,
    // Ignored fields
    CollectiveId: 0,
    HostCollectiveId: 0,
    ParentCollectiveId: 0,
    createdAt: 0,
    updatedAt: 0,
    type: 0,
  };

  public findEntriesToIndex(options: FindEntriesToIndexOptions = {}) {
    return models.Tier.findAll({
      attributes: omit(Object.keys(this.mappings.properties), ['HostCollectiveId', 'ParentCollectiveId']),
      order: [['id', 'DESC']],
      limit: options.limit,
      offset: options.offset,
      where: {
        ...(options.fromDate ? { updatedAt: options.fromDate } : null),
        ...(options.maxId ? { id: { [Op.lte]: options.maxId } } : null),
        ...(options.ids?.length ? { id: options.ids } : null),
        ...(options.relatedToCollectiveIds?.length ? { CollectiveId: options.relatedToCollectiveIds } : null),
      },
      include: [
        {
          association: 'Collective',
          required: true,
          attributes: ['isActive', 'HostCollectiveId', 'ParentCollectiveId'],
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
      HostCollectiveId: !instance.Collective.isActive ? null : instance.Collective.HostCollectiveId,
      ParentCollectiveId: instance.Collective.ParentCollectiveId,
    };
  }

  public getIndexPermissions(/* _adminOfAccountIds: number[]*/) {
    return { default: 'PUBLIC' as const };
  }

  public getPersonalizationFilters(userId: number | null, adminOfAccountIds: number[], isRoot: boolean) {
    /* eslint-disable camelcase */
    if (isRoot) {
      return null; // No filter, show all
    }

    if (!adminOfAccountIds.length) {
      return null; // No user context, show all
    }

    return [
      {
        bool: {
          minimum_should_match: 1,
          should: [
            { terms: { HostCollectiveId: adminOfAccountIds } },
            { terms: { ParentCollectiveId: adminOfAccountIds } },
            { terms: { CollectiveId: adminOfAccountIds } },
          ],
        },
      },
    ];
    /* eslint-enable camelcase */
  }
}

import models, { Op } from '../../../models';
import { stripHTMLOrEmpty } from '../../sanitize-html';
import { ElasticSearchIndexName } from '../constants';

import { ElasticSearchModelAdapter } from './ElasticSearchModelAdapter';

export class ElasticSearchCollectivesAdapter implements ElasticSearchModelAdapter {
  public readonly model = models.Collective;
  public readonly index = ElasticSearchIndexName.COLLECTIVES;
  public readonly mappings = {
    properties: {
      id: { type: 'keyword' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
      slug: { type: 'keyword' },
      name: { type: 'text' },
      type: { type: 'keyword' },
      legalName: { type: 'text' },
      countryISO: { type: 'keyword' },
      description: { type: 'text' },
      longDescription: { type: 'text' },
      website: { type: 'keyword' },
      isActive: { type: 'boolean' },
      isHostAccount: { type: 'boolean' },
      deactivatedAt: { type: 'date' },
      // Relationships
      HostCollectiveId: { type: 'keyword' },
      ParentCollectiveId: { type: 'keyword' },
      // TODO: Social accounts
      // TODO: administrated accounts
      // TODO: location
    },
  } as const;

  public async findEntriesToIndex(
    offset: number,
    limit: number,
    options: { fromDate: Date; firstReturnedId: number },
  ): Promise<Array<InstanceType<typeof models.Collective>>> {
    return models.Collective.findAll({
      attributes: Object.keys(this.mappings.properties),
      order: [['id', 'DESC']],
      limit,
      offset,
      raw: true,
      where: {
        ...(options.fromDate ? { updatedAt: options.fromDate } : null),
        ...(options.firstReturnedId ? { id: { [Op.lte]: options.firstReturnedId } } : null),
      },
    });
  }

  public mapModelInstanceToDocument(
    instance: InstanceType<typeof models.Collective>,
  ): Record<keyof (typeof this.mappings)['properties'], unknown> {
    return {
      id: instance.id,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      slug: instance.slug,
      name: instance.name,
      type: instance.type,
      legalName: instance.legalName,
      countryISO: instance.countryISO,
      description: instance.description,
      longDescription: stripHTMLOrEmpty(instance.longDescription),
      website: instance.website,
      isActive: instance.isActive,
      isHostAccount: instance.isHostAccount,
      deactivatedAt: instance.deactivatedAt,
      HostCollectiveId: instance.HostCollectiveId,
      ParentCollectiveId: instance.ParentCollectiveId,
    };
  }

  public getIndexPermissions(adminOfAccountIds: number[]) {
    /* eslint-disable camelcase */
    if (!adminOfAccountIds.length) {
      return {
        default: 'PUBLIC' as const,
        fields: {
          legalName: 'FORBIDDEN' as const,
        },
      };
    }

    return {
      default: 'PUBLIC' as const,
      fields: {
        legalName: {
          bool: {
            minimum_should_match: 1,
            should: [
              { terms: { HostCollectiveId: adminOfAccountIds } },
              { terms: { ParentCollectiveId: adminOfAccountIds } },
              { terms: { CollectiveId: adminOfAccountIds } },
            ],
          },
        },
      },
    };
    /* eslint-enable camelcase */
  }
}

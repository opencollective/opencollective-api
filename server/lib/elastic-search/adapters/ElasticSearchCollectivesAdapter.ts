import models from '../../../models';
import { ElasticSearchIndexName } from '../const';
import { ElasticSearchModelToIndexAdapter } from '../ElasticSearchModelToIndexAdapter';

export class ElasticSearchCollectivesAdapter implements ElasticSearchModelToIndexAdapter {
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

  public getAttributesForFindAll(): string[] {
    return Object.keys(this.mappings.properties);
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
      longDescription: instance.longDescription,
      website: instance.website,
      isActive: instance.isActive,
      isHostAccount: instance.isHostAccount,
      deactivatedAt: instance.deactivatedAt,
      HostCollectiveId: instance.HostCollectiveId,
      ParentCollectiveId: instance.ParentCollectiveId,
    };
  }
}

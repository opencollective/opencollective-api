import models, { Collective } from '../../../models';
import { ElasticSearchIndexName } from '../const';
import { ElasticSearchModelToIndexAdapter } from '../ElasticSearchModelToIndexAdapter';

const MAPPINGS = {
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

export class ElasticSearchCollectivesAdapter implements ElasticSearchModelToIndexAdapter {
  public readonly model = Collective;
  public readonly mappings = MAPPINGS;
  public readonly index = ElasticSearchIndexName.COLLECTIVES;

  public async mapModelInstanceToDocument(
    instance: InstanceType<typeof models.Collective>,
  ): Promise<Record<keyof (typeof MAPPINGS)['properties'], unknown>> {
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

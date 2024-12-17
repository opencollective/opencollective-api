import { omit } from 'lodash';
import { Op } from 'sequelize';

import models from '../../../models';
import { stripHTMLOrEmpty } from '../../sanitize-html';
import { ElasticSearchIndexName } from '../constants';

import { ElasticSearchModelAdapter, FindEntriesToIndexOptions } from './ElasticSearchModelAdapter';

export class ElasticSearchExpensesAdapter implements ElasticSearchModelAdapter {
  public readonly index = ElasticSearchIndexName.EXPENSES;
  public readonly mappings = {
    properties: {
      id: { type: 'keyword' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
      description: { type: 'text' },
      longDescription: { type: 'text' },
      privateMessage: { type: 'text' },
      invoiceInfo: { type: 'text' },
      reference: { type: 'text' },
      amount: { type: 'integer' },
      currency: { type: 'keyword' },
      status: { type: 'keyword' },
      // Relationships
      UserId: { type: 'keyword' },
      CollectiveId: { type: 'keyword' },
      FromCollectiveId: { type: 'keyword' },
      HostCollectiveId: { type: 'keyword' },
      // Special fields
      ParentCollectiveId: { type: 'keyword' },
      items: { type: 'text' },
    },
  } as const;

  public getModel() {
    return models.Expense;
  }

  public findEntriesToIndex(options: FindEntriesToIndexOptions = {}) {
    return models.Expense.findAll({
      attributes: omit(Object.keys(this.mappings.properties), ['ParentCollectiveId', 'items']),
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
                { HostCollectiveId: options.relatedToCollectiveIds },
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
          association: 'items',
          required: true,
          attributes: ['description'],
        },
        {
          association: 'items',
          required: false,
          attributes: ['description'],
        },
      ],
    });
  }

  public mapModelInstanceToDocument(
    instance: InstanceType<typeof models.Expense>,
  ): Record<keyof (typeof this.mappings)['properties'], unknown> {
    return {
      id: instance.id,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      description: instance.description,
      longDescription: stripHTMLOrEmpty(instance.longDescription),
      privateMessage: stripHTMLOrEmpty(instance.privateMessage),
      invoiceInfo: instance.invoiceInfo,
      reference: instance.reference,
      amount: instance.amount,
      currency: instance.currency,
      status: instance.status,
      CollectiveId: instance.CollectiveId,
      ParentCollectiveId: instance.collective.ParentCollectiveId,
      FromCollectiveId: instance.FromCollectiveId,
      UserId: instance.UserId,
      items: instance.items.map(item => item.description).join(', '),
      HostCollectiveId:
        instance.HostCollectiveId || (!instance.collective.isActive ? null : instance.collective.HostCollectiveId),
    };
  }

  public getIndexPermissions(adminOfAccountIds: number[]) {
    /* eslint-disable camelcase */
    const adminFieldPermissions = !adminOfAccountIds.length
      ? ('FORBIDDEN' as const)
      : {
          bool: {
            minimum_should_match: 1,
            should: [
              { terms: { HostCollectiveId: adminOfAccountIds } },
              { terms: { ParentCollectiveId: adminOfAccountIds } },
              { terms: { CollectiveId: adminOfAccountIds } },
              { terms: { FromCollectiveId: adminOfAccountIds } },
            ],
          },
        };

    return {
      default: 'PUBLIC' as const,
      fields: {
        privateMessage: adminFieldPermissions,
        invoiceInfo: adminFieldPermissions,
        reference: adminFieldPermissions,
      },
    };
    /* eslint-enable camelcase */
  }
}

import DataLoader from 'dataloader';
import type { ModelStatic } from 'sequelize';

import { EntityShortIdPrefix } from '../../lib/permalink/entity-map';
import { Op } from '../../models';
import { ModelWithPublicId } from '../../models/ModelWithPublicId';

import { sortResultsSimple } from './helpers';

export function generateEntityByPublicIdLoader<
  MS extends ModelStatic<ModelWithPublicId<EntityShortIdPrefix, any, any>>,
>(Model: MS): DataLoader<string, InstanceType<MS> | null> {
  return new DataLoader(async (publicIds: string[]) => {
    const results = await Model.findAll({ where: { publicId: { [Op.in]: publicIds } } });
    return sortResultsSimple(publicIds, results, result => result.publicId) as InstanceType<MS>[];
  });
}

export function generateEntityIdByPublicIdLoader<
  MS extends ModelStatic<ModelWithPublicId<EntityShortIdPrefix, any, any>>,
>(Model: MS): DataLoader<string, number | null> {
  return new DataLoader(async (publicIds: string[]) => {
    const results = await Model.findAll({
      where: { publicId: { [Op.in]: publicIds } },
      attributes: ['id', 'publicId'],
    });
    return sortResultsSimple(publicIds, results, result => result.publicId).map(result => result?.['id'] ?? null);
  });
}

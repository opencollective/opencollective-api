import DataLoader from 'dataloader';
import type { ModelStatic } from 'sequelize';

import { EntityShortIdPrefix } from '../../lib/permalink/entity-map';
import { Op } from '../../models';
import { ModelWithPublicId } from '../../models/ModelWithPublicId';

import { sortResultsSimple } from './helpers';

// NB: T/C must stay `any` here. Concrete attribute types (e.g. `Record<string, unknown>`)
// break generic models like `KYCVerification<Provider>` whose conditional `KYCData<Provider>`
// payload is not assignable to any concrete attributes type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModelWithPublicId = ModelWithPublicId<EntityShortIdPrefix, any, any>;

export function generateEntityByPublicIdLoader<MS extends ModelStatic<AnyModelWithPublicId>>(
  Model: MS,
): DataLoader<string, InstanceType<MS> | null> {
  return new DataLoader(async (publicIds: string[]) => {
    const results = await Model.findAll({ where: { publicId: { [Op.in]: publicIds } } });
    return sortResultsSimple(publicIds, results, result => result.publicId) as InstanceType<MS>[];
  });
}

export function generateEntityIdByPublicIdLoader<MS extends ModelStatic<AnyModelWithPublicId>>(
  Model: MS,
): DataLoader<string, number | null> {
  return new DataLoader(async (publicIds: string[]) => {
    const results = await Model.findAll({
      where: { publicId: { [Op.in]: publicIds } },
      attributes: ['id', 'publicId'],
    });
    return sortResultsSimple(publicIds, results, result => result.publicId).map(result => result?.['id'] ?? null);
  });
}

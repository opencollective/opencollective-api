import { CreationOptional, Model } from 'sequelize';

import { EntityPublicId, EntityShortIdPrefix } from '../lib/permalink/entity-map';

export abstract class ModelWithPublicId<E extends EntityShortIdPrefix, T, C> extends Model<T, C> {
  declare public readonly publicId: CreationOptional<EntityPublicId<E>>;
}

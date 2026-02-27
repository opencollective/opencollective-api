import { CreationOptional, Model } from 'sequelize';

export abstract class ModelWithPublicId<T, C> extends Model<T, C> {
  declare public readonly publicId: CreationOptional<string>;
}

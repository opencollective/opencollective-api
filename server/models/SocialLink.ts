import type { CreationOptional, InferAttributes, InferCreationAttributes, NonAttribute } from 'sequelize';

import sequelize, { DataTypes, Model } from '../lib/sequelize';

import Collective from './Collective';

export enum SocialLinkType {
  TWITTER = 'TWITTER',
  TUMBLR = 'TUMBLR',
  MASTODON = 'MASTODON',
  MATTERMOST = 'MATTERMOST',
  SLACK = 'SLACK',
  LINKEDIN = 'LINKEDIN',
  MEETUP = 'MEETUP',
  FACEBOOK = 'FACEBOOK',
  INSTAGRAM = 'INSTAGRAM',
  DISCORD = 'DISCORD',
  YOUTUBE = 'YOUTUBE',
  GITHUB = 'GITHUB',
  GITLAB = 'GITLAB',
  GIT = 'GIT',
  WEBSITE = 'WEBSITE',
  DISCOURSE = 'DISCOURSE',
  PIXELFED = 'PIXELFED',
  GHOST = 'GHOST',
  PEERTUBE = 'PEERTUBE',
  TIKTOK = 'TIKTOK',
}

class SocialLink extends Model<InferAttributes<SocialLink>, InferCreationAttributes<SocialLink>> {
  public declare CollectiveId: number;
  public declare type: SocialLinkType;
  public declare url: string;
  public declare order: number;
  public declare createdAt: CreationOptional<Date>;
  public declare updatedAt: CreationOptional<Date>;

  public declare collective?: NonAttribute<Collective>;
}

SocialLink.init(
  {
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: { model: 'Collectives', key: 'id' },
      primaryKey: true,
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false,
      primaryKey: true,
      defaultValue: SocialLinkType.WEBSITE,
    },
    url: {
      type: DataTypes.STRING,
      allowNull: false,
      primaryKey: true,
      validate: {
        isUrl: {
          msg: 'Social link URL must be a valid URL',
        },
      },
    },
    order: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'SocialLinks',
  },
);

export default SocialLink;

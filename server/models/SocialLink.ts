import type { CreationOptional, InferAttributes, InferCreationAttributes, NonAttribute } from 'sequelize';

import sequelize, { DataTypes, Model } from '../lib/sequelize';

import Collective from './Collective';

export enum SocialLinkType {
  BLUESKY = 'BLUESKY',
  DISCORD = 'DISCORD',
  DISCOURSE = 'DISCOURSE',
  FACEBOOK = 'FACEBOOK',
  GHOST = 'GHOST',
  GIT = 'GIT',
  GITHUB = 'GITHUB',
  GITLAB = 'GITLAB',
  INSTAGRAM = 'INSTAGRAM',
  LINKEDIN = 'LINKEDIN',
  MASTODON = 'MASTODON',
  MATTERMOST = 'MATTERMOST',
  MEETUP = 'MEETUP',
  PEERTUBE = 'PEERTUBE',
  PIXELFED = 'PIXELFED',
  SLACK = 'SLACK',
  THREADS = 'THREADS',
  TIKTOK = 'TIKTOK',
  TUMBLR = 'TUMBLR',
  TWITCH = 'TWITCH',
  TWITTER = 'TWITTER',
  WEBSITE = 'WEBSITE',
  YOUTUBE = 'YOUTUBE',
}

class SocialLink extends Model<InferAttributes<SocialLink>, InferCreationAttributes<SocialLink>> {
  declare public CollectiveId: number;
  declare public type: SocialLinkType;
  declare public url: string;
  declare public order: number;
  declare public createdAt: CreationOptional<Date>;
  declare public updatedAt: CreationOptional<Date>;

  declare public collective?: NonAttribute<Collective>;
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

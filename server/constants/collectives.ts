import config from 'config';

export enum CollectiveType {
  COLLECTIVE = 'COLLECTIVE',
  EVENT = 'EVENT',
  USER = 'USER',
  ORGANIZATION = 'ORGANIZATION',
  BOT = 'BOT',
  PROJECT = 'PROJECT',
  FUND = 'FUND',
  VENDOR = 'VENDOR',
}

export const CollectiveTypesList = Object.values(CollectiveType);

export const DEFAULT_BACKGROUND_IMG = `${config.host.website}/public/images/collectives/default-header-bg.jpg`;

export const defaultBackgroundImage = {
  COLLECTIVE: `${config.host.website}/static/images/defaultBackgroundImage.png`,
  USER: `${config.host.website}/static/images/defaultBackgroundImage-profile.svg`,
};

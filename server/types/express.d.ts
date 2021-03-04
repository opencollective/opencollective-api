import DataLoader from 'dataloader';

import models from '../models';

declare global {
  namespace Express {
    interface Request {
      remoteUser?: typeof models.User;
      loaders: Record<string, DataLoader>;
    }
  }
}

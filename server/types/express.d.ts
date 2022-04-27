import DataLoader from 'dataloader';

import models from '../models';

declare global {
  namespace Express {
    interface Request {
      remoteUser?: typeof models.User;
      jwtPayload?: {
        sessionId?: string;
        iat: number;
        exp: number;
        sub?: string;
      };
      loaders: Record<string, DataLoader>;
    }
  }
}

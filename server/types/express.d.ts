import DataLoader from 'dataloader';

import PersonalToken from '../models/PersonalToken';
import User from '../models/User';
import UserToken from '../models/UserToken';

declare global {
  namespace Express {
    interface Request {
      remoteUser?: User | null;
      jwtPayload?: {
        sessionId?: string;
        iat: number;
        exp: number;
        sub?: string;
      };
      clientApp?: {
        id: number;
        type?: string;
        name?: string;
        description?: string;
        CollectiveId: number;
      };
      userToken?: UserToken;
      personalToken?: PersonalToken;
      loaders: Record<string, DataLoader>;
      rawBody?: string;
    }
  }
}

import type { Loaders } from '../graphql/loaders';
import type { MiddlewareTimingTracker } from '../lib/middleware-timing';
import type { PersonalToken, User, UserToken } from '../models';

declare global {
  namespace Express {
    export interface Request {
      remoteUser?: User;
      isGraphQL?: boolean;
      apiKey?: string;
      jwtPayload?: {
        sessionId?: string;
        scope?: string;
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
      loaders: Loaders;
      rawBody?: string;
      params: Record<string, string>;
      method: string;
      baseUrl: string;
      ip: string;
      middlewareTimingTracker?: MiddlewareTimingTracker;
    }
  }
}

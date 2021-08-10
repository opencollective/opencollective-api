import express from 'express';

export interface Query<ArgType> {
  type: any;
  description?: string;
  args: ArgType;
  resolve: (context: any, args: Record<keyof ArgType, any>, req: express.Request) => any;
}

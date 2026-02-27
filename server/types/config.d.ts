// Override config module types to add an index signature for direct property access
// (e.g. config.env, config.host) used throughout the codebase.
//
// config@4.4.1 ships types where ConfigClass has no index signature and is not exported,
// so a proper module augmentation cannot extend it. This ambient module declaration
// takes precedence over the package's own types during resolution.
declare module 'config' {
  interface IConfig {
    get<T>(property: string): T;
    has(property: string): boolean;
    util: {
      getEnv(varName: string): string;
      toObject(config?: object): object;
      [key: string]: any;
    };
    [key: string]: any;
  }

  const config: IConfig;
  export = config;
}

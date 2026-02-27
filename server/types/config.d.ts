declare module 'config' {
  interface IConfig {
    get<T>(property: string): T;
    has(property: string): boolean;
    [key: string]: any;
  }

  const config: IConfig;
  export = config;
}

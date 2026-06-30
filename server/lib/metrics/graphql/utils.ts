import { Dimension, MetricSource } from '../internal/types';

export function gqlNameForDimension(d: Dimension): string {
  return d.name;
}

function findDimensionByGraphQLName(source: MetricSource, gqlName: string): Dimension | undefined {
  return Object.values(source.dimensions).find(d => d.name === gqlName);
}

export function graphqlNameToDimName(source: MetricSource, gqlName: string): string {
  return findDimensionByGraphQLName(source, gqlName)?.name ?? gqlName;
}

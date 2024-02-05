type ViewDefinition = { name: string; isMaterialized: boolean };

/**
 * This helper:
 * 1. Snapshots all the views referenced in `views`
 * 2. Drops all the aforementioned views
 * 3. Optionally executes a custom query when the views are dropped. This is useful for editing tables referenced by the views.
 * 4. Recreates all the views from the snapshots
 *
 * All that in a single transaction, to restore everything in case of failure.
 */
export const getRecreateViewsQuery = (views: ViewDefinition | ViewDefinition[], customQuery: string = ''): string => {
  const viewsArray = Array.isArray(views) ? views : [views];
  const viewDefinitions = viewsArray.map(view => ({
    ...view,
    definition: `view_${view.name}_definition`,
    execute: `view_${view.name}_execute`,
  }));

  return `
    DO $$
    ${viewDefinitions.map(({ definition }) => `DECLARE "${definition}" TEXT;`).join('\n')}
    ${viewDefinitions.map(({ execute }) => `DECLARE "${execute}" TEXT;`).join('\n')}
    BEGIN
      -- Store all view definitions in variables
      ${viewDefinitions.map(({ name, definition }) => `"${definition}" := PG_GET_VIEWDEF('"${name}"');`).join('\n')}
      -- Drop all views
      ${viewDefinitions.map(({ name, isMaterialized }) => `DROP ${isMaterialized ? 'MATERIALIZED ' : ''} VIEW "${name}";`).join('\n')}
      -- Custom query
      ${customQuery}
      -- Recreate views
      ${viewDefinitions
        .map(
          ({ name, definition, execute, isMaterialized }) =>
            `"${execute}" := FORMAT('CREATE ${isMaterialized ? 'MATERIALIZED' : ''} VIEW "${name}" AS %s', "${definition}"); EXECUTE "${execute}";`,
        )
        .join('\n')}
    END $$;
  `;
};

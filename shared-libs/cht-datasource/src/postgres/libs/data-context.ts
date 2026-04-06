import { DataContext } from '../../libs/data-context';
import { AbstractDataContext, hasField, isRecord } from '../../libs/core';
import { SettingsService } from '../../local/libs/data-context';

/**
 * A minimal interface for a PostgreSQL connection pool. This matches the `pg.Pool` API
 * so callers can pass a `pg.Pool` instance directly, without cht-datasource depending on `pg`.
 */
export interface DatabasePool {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: T[], rowCount: number }>;
}

/**
 * Configuration for the PostgreSQL data tables. Matches the cht-sync schema layout.
 */
export interface PostgresSchemaConfig {
  /** PostgreSQL schema name. Default: 'v1' */
  readonly schema: string;
  /** Raw JSONB document table name. Default: 'couchdb' */
  readonly table: string;
}

const DEFAULT_SCHEMA_CONFIG: PostgresSchemaConfig = {
  schema: 'v1',
  table: 'couchdb',
};

/** @internal */
export class PostgresDataContext extends AbstractDataContext {
  readonly schemaConfig: PostgresSchemaConfig;

  /** @internal */
  constructor(
    readonly pool: DatabasePool,
    readonly settings: SettingsService,
    schemaConfig?: Partial<PostgresSchemaConfig>,
  ) {
    super();
    this.schemaConfig = { ...DEFAULT_SCHEMA_CONFIG, ...schemaConfig };
  }

  /** Returns the fully-qualified table name: `"schema"."table"` */
  get qualifiedTable(): string {
    return `"${this.schemaConfig.schema}"."${this.schemaConfig.table}"`;
  }
}

/** @internal */
export const isPostgresDataContext = (context: DataContext): context is PostgresDataContext => {
  return 'pool' in context && 'settings' in context && 'schemaConfig' in context;
};

/** @internal */
export const assertPostgresDataContext: (context: DataContext) => asserts context is PostgresDataContext = (
  context: DataContext
) => {
  if (!isPostgresDataContext(context)) {
    throw new Error(`Invalid PostgreSQL data context [${JSON.stringify(context)}].`);
  }
};

const assertDatabasePool: (pool: unknown) => asserts pool is DatabasePool = (pool: unknown) => {
  if (!isRecord(pool) || !hasField(pool, { name: 'query', type: 'function' })) {
    throw new Error(`Invalid database pool [${JSON.stringify(pool)}].`);
  }
};

const assertSettingsService: (settings: unknown) => asserts settings is SettingsService = (settings: unknown) => {
  if (!isRecord(settings) || !hasField(settings, { name: 'getAll', type: 'function' })) {
    throw new Error(`Invalid settings service [${JSON.stringify(settings)}].`);
  }
};

/**
 * Returns the data context for accessing data via PostgreSQL. This context is intended for
 * server-side use cases where data has been replicated from CouchDB to PostgreSQL via cht-sync.
 * @param pool a database connection pool implementing the {@link DatabasePool} interface (e.g. a `pg.Pool`)
 * @param settings service providing access to the app settings
 * @param schemaConfig optional schema/table configuration (defaults to cht-sync's `v1.couchdb`)
 * @returns the PostgreSQL data context
 * @throws Error if the provided pool or settings are invalid
 */
export const getPostgresDataContext = (
  pool: DatabasePool,
  settings: SettingsService,
  schemaConfig?: Partial<PostgresSchemaConfig>,
): DataContext => {
  assertDatabasePool(pool);
  assertSettingsService(settings);
  return new PostgresDataContext(pool, settings, schemaConfig);
};

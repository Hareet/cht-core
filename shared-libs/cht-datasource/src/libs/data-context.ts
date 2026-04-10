import { hasField, isRecord } from './core';
import { isLocalDataContext, LocalDataContext } from '../local/libs/data-context';
import { assertRemoteDataContext, isRemoteDataContext, RemoteDataContext } from '../remote/libs/data-context';
import {
  assertPostgresDataContext,
  isPostgresDataContext,
  PostgresDataContext
} from '../postgres/libs/data-context';

/**
 * Context for interacting with the data. This may represent a local data context where data can be accessed even while
 * offline. Or it may represent a remote data context where all data operations are performed against a remote CHT
 * instance. Or it may represent a PostgreSQL data context where data is accessed via a PostgreSQL database.
 */
export interface DataContext {
  /**
   * Executes the provided function with this data context as the argument.
   * @param fn the function to execute
   * @returns the result of the function
   */
  bind: <T>(fn: (ctx: DataContext) => T) => T;
}

const isDataContext = (context: unknown): context is DataContext => {
  return isRecord(context) && hasField(context, { name: 'bind', type: 'function' });
};

/** @internal */
export const assertDataContext: (context: unknown) => asserts context is DataContext = (context: unknown) => {
  if (!isDataContext(context) || !(
    isLocalDataContext(context) || isRemoteDataContext(context) || isPostgresDataContext(context)
  )) {
    throw new Error(`Invalid data context [${JSON.stringify(context)}].`);
  }
};

/** @internal */
export const adapt = <T>(
  context: DataContext,
  local: (c: LocalDataContext) => T,
  remote: (c: RemoteDataContext) => T,
  postgres?: (c: PostgresDataContext) => T
): T => {
  if (isLocalDataContext(context)) {
    return local(context);
  }
  if (isPostgresDataContext(context)) {
    if (!postgres) {
      throw new Error('PostgreSQL adapter not available for this operation.');
    }
    return postgres(context);
  }
  assertRemoteDataContext(context);
  return remote(context);
};

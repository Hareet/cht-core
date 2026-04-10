/**
 * Represents an error that occurs when an invalid argument is provided.
 * This error is typically thrown when a function or method receives an argument
 * that doesn't meet the expected criteria or constraints.
 */
export class InvalidArgumentError extends Error {
  /**
   * Constructor
   * @param message a descriptive error message why the error was raised
   */
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArgumentError';
  }
}

/**
 * Represents an error that occurs when an identified resource could not be found in the datastore.
 */
export class ResourceNotFoundError extends Error {
  /**
   * Constructor
   * @param message a descriptive error message why the error was raised
   */
  constructor(message: string) {
    super(message);
    this.name = 'ResourceNotFoundError';
  }
}

/**
 * Represents an error that occurs when an update fails because the document's revision
 * does not match the current revision in the datastore. This is analogous to CouchDB's
 * 409 Conflict status and indicates a concurrent modification.
 */
export class RevisionConflictError extends Error {
  /**
   * Constructor
   * @param message a descriptive error message why the error was raised
   */
  constructor(message: string) {
    super(message);
    this.name = 'RevisionConflictError';
  }
}

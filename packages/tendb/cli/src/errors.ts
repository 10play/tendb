/**
 * Typed errors mapped to documented exit codes:
 *   0 success · 1 generic · 2 usage · 3 not found · 4 timeout/fatal ·
 *   5 missing local dependency · 10 platform down · 42 capacity exhausted
 */
export class TenDBError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1,
    readonly hint?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UsageError extends TenDBError {
  constructor(message: string, hint?: string) {
    super(message, 2, hint);
  }
}

export class NotFoundError extends TenDBError {
  constructor(message: string, hint?: string) {
    super(message, 3, hint);
  }
}

export class TimeoutError extends TenDBError {
  constructor(message: string, hint?: string) {
    super(message, 4, hint);
  }
}

export class MissingDependencyError extends TenDBError {
  constructor(message: string, hint?: string) {
    super(message, 5, hint);
  }
}

export class PlatformDownError extends TenDBError {
  constructor(message: string, hint?: string) {
    super(message, 10, hint);
  }
}

export class CapacityError extends TenDBError {
  constructor(message: string, hint?: string) {
    super(message, 42, hint);
  }
}

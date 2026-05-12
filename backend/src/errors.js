export class AppError extends Error {
  constructor(status, message, { code, publicMessage, details, cause, retryable, logDetails } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code || 'UNKNOWN';
    this.publicMessage = publicMessage || message;
    this.details = details || null;
    this.retryable = Boolean(retryable);
    this.logDetails = logDetails || null;
    if (cause) this.cause = cause;
  }
}

export class NotFoundError extends AppError {
  constructor(resource, id) {
    super(404, `${resource} not found: ${id}`, { code: 'NOT_FOUND' });
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super(400, message, { code: 'VALIDATION_ERROR', details });
  }
}

export class InstallerDisabledError extends AppError {
  constructor() {
    super(403, 'Installer actions are disabled', {
      code: 'INSTALLER_DISABLED',
      publicMessage: 'Installer actions are disabled. Enable installer mode before retrying.',
    });
  }
}

export class InstallerConflictError extends AppError {
  constructor(conflicts = []) {
    super(
      409,
      `Installer cannot take over existing unmanaged containers: ${conflicts.join(', ')}`,
      {
        code: 'INSTALLER_CONFLICT',
        publicMessage: 'Setup cannot continue because one or more selected services already exist outside installer management.',
        details: { conflicts },
      },
    );
  }
}

export class InstallerValidationError extends AppError {
  constructor(message, details = null) {
    super(400, message, {
      code: 'INSTALLER_VALIDATION_ERROR',
      publicMessage: 'The setup request is invalid. Review the highlighted fields and retry.',
      details,
    });
  }
}

export class InstallerExecutionError extends AppError {
  constructor(message, { code = 'INSTALLER_FAILED', publicMessage, details, cause, retryable, logDetails } = {}) {
    super(500, message, {
      code,
      publicMessage: publicMessage || 'Setup failed before the dashboard could finish configuring services.',
      details,
      cause,
      retryable,
      logDetails,
    });
  }
}

export class ServiceError extends AppError {
  constructor(service, message, cause) {
    const status = cause?.status || 502;
    super(status, `[${service}] ${message}`, { code: 'SERVICE_ERROR', cause });
  }
}

export class UnconfiguredError extends AppError {
  constructor(service) {
    super(503, `${service} not configured`, { code: 'UNCONFIGURED' });
  }
}

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function wrapRouter(router) {
  const originalGet = router.get;
  const originalPost = router.post;
  const originalDelete = router.delete;
  const originalPut = router.put;

  // Mutate verb helpers once so route modules can use async handlers without local wrappers.
  const wrap = (method) => {
    return function (...args) {
      const wrappedArgs = args.map((arg) =>
        typeof arg === 'function' ? asyncHandler(arg) : arg,
      );
      return method.call(this, ...wrappedArgs);
    };
  };

  router.get = wrap(originalGet);
  router.post = wrap(originalPost);
  router.delete = wrap(originalDelete);
  router.put = wrap(originalPut);

  return router;
}

import { ValidationError, UnconfiguredError } from './errors.js';

export function requireService(apiKey, serviceName) {
  if (!apiKey) throw new UnconfiguredError(serviceName);
}

export function requireParam(req, ...names) {
  const missing = names.filter(n => req.query[n] === undefined || req.query[n] === '');
  if (missing.length > 0) {
    throw new ValidationError(`Missing required parameter(s): ${missing.join(', ')}`);
  }
}

export function requireBody(req, ...names) {
  const missing = names.filter(n => req.body[n] === undefined || req.body[n] === null);
  if (missing.length > 0) {
    throw new ValidationError(`Missing required field(s): ${missing.join(', ')}`);
  }
}

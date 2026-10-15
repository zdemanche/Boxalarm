import { ApiError } from '../../lib/apiClient';

export function problemMessage(error: Error): string {
  return error instanceof ApiError ? (error.problem.detail ?? error.problem.title) : error.message;
}

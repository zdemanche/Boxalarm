export interface AuthTokenSource {
  getAccessToken: () => Promise<string | null>;
  renewSilently: () => Promise<string | null>;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  traceId: string;
}

export class ApiError extends Error {
  constructor(public readonly problem: ProblemDetails) {
    super(problem.title);
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
  apiBaseUrl: string;
}

const API_PATH_PREFIX = '/api/v1/';

export async function apiRequest(
  path: string,
  tokens: AuthTokenSource,
  options: ApiRequestOptions,
): Promise<Response> {
  const { apiBaseUrl, ...init } = options;
  const send = (token: string | null) =>
    fetch(`${apiBaseUrl}${API_PATH_PREFIX}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

  let response = await send(await tokens.getAccessToken());

  if (response.status === 401) {
    const renewedToken = await tokens.renewSilently();
    if (renewedToken) {
      response = await send(renewedToken);
    }
  }

  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as ProblemDetails | null;
    throw new ApiError(
      problem ?? {
        type: 'about:blank',
        title: response.statusText,
        status: response.status,
        traceId: 'unknown',
      },
    );
  }

  return response;
}

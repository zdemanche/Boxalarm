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
}

const API_BASE = '/api/v1/';

export async function apiRequest(
  path: string,
  tokens: AuthTokenSource,
  options: ApiRequestOptions = {},
): Promise<Response> {
  const send = (token: string | null) =>
    fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        ...options.headers,
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

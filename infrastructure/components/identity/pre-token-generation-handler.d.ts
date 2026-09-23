export interface PreTokenGenerationV2Event {
  request: { userAttributes: Record<string, string> };
  response: {
    claimsAndScopeOverrideDetails?: {
      accessTokenGeneration?: {
        claimsToAddOrOverride?: Record<string, string>;
      };
    };
  };
}

export function handler(event: PreTokenGenerationV2Event): Promise<PreTokenGenerationV2Event>;

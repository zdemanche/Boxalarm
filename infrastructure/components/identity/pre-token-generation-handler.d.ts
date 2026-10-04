export interface PreTokenGenerationV2Event {
  triggerSource?: string;
  request: { userAttributes: Record<string, string> };
  response: {
    claimsAndScopeOverrideDetails?: {
      accessTokenGeneration?: {
        claimsToAddOrOverride?: Record<string, string>;
      };
    };
  };
}

export interface PreTokenGenerationDeps {
  tableName: string | undefined;
  readMemberStatus: (
    tableName: string,
    deptId: string,
    memberId: string,
  ) => Promise<string | undefined>;
}

export function createHandler(
  deps: PreTokenGenerationDeps,
): (event: PreTokenGenerationV2Event) => Promise<PreTokenGenerationV2Event>;

export function handler(event: PreTokenGenerationV2Event): Promise<PreTokenGenerationV2Event>;

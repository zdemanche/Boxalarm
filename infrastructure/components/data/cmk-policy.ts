/**
 * Shared CMK key policy for the customer-managed DynamoDB encryption keys
 * (alerting-table, incident-table). Previously duplicated verbatim across both
 * table components — a future policy fix could land on one table and not the
 * other with nothing failing.
 */
export function dynamodbCmkPolicy(accountId: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "EnableRootAccountAdministration",
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${accountId}:root` },
        Action: "kms:*",
        Resource: "*",
      },
      {
        Sid: "AllowDynamoDBService",
        Effect: "Allow",
        Principal: { Service: "dynamodb.amazonaws.com" },
        Action: [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey",
          "kms:CreateGrant",
        ],
        Resource: "*",
      },
    ],
  });
}

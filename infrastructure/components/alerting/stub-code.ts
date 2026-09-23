import * as path from "path";
import * as pulumi from "@pulumi/pulumi";

function archiveFor(fileName: string): pulumi.asset.AssetArchive {
  return new pulumi.asset.AssetArchive({
    "index.js": new pulumi.asset.FileAsset(path.join(__dirname, fileName)),
  });
}

/** API Gateway route stub — fail-closed 503 Problem+JSON. */
export function httpStubCode(): pulumi.asset.AssetArchive {
  return archiveFor("http-stub-handler.js");
}

/** SQS / DynamoDB Stream stub — fail-open no-op ack. */
export function asyncStubCode(): pulumi.asset.AssetArchive {
  return archiveFor("async-stub-handler.js");
}

/** Direct-invoke (EventBridge Scheduler target) stub. */
export function invokeStubCode(): pulumi.asset.AssetArchive {
  return archiveFor("invoke-stub-handler.js");
}

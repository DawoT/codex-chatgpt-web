import type { NativeImageEndpoint } from "../native-passthrough";

export type HttpTrackedEndpoint =
  | "models"
  | "responses"
  | "compact"
  | "search"
  | "unspecified"
  | NativeImageEndpoint;

export interface NativeCodexTurnIdentity {
  threadId: string;
  turnId: string;
}

export interface HttpStreamFailureEvidence {
  httpTurnId: number;
  endpoint: HttpTrackedEndpoint;
  reader: "client" | "windows_lifecycle";
  platform: NodeJS.Platform;
  chunks: number;
  bytes: number;
  errorName: string;
  errorCode: string;
}

export type HttpStreamFailureReporter = (evidence: HttpStreamFailureEvidence) => void;

export type ModelCatalogFailure =
  | { kind: "config"; error: string }
  | { kind: "upstream"; status: number; error: string };

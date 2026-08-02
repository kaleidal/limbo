export type ApiApprovalVerified = {
  pid: number | null;
  exePath: string | null;
  displayName: string | null;
  iconDataUrl: string | null;
  trustKey: string | null;
  method: "tcp-peer" | "unknown";
};

export type ApiApprovalRequest = {
  clientId: string;
  clientName: string;
  clientVersion?: string;
  magnet: string;
  displayName: string;
  fileIndex: number | null;
  sequential: boolean;
  verified?: ApiApprovalVerified;
};

export type ApiApprovalBridge = {
  getRequest: (requestId: string) => Promise<ApiApprovalRequest | null>;
  decide: (payload: {
    requestId: string;
    approved: boolean;
    remember: boolean;
  }) => void;
};

export function getApprovalBridge(): ApiApprovalBridge | null {
  const fenestra = window.fenestra;
  if (!fenestra?.bridge) return null;
  return {
    getRequest: (requestId) =>
      fenestra.bridge.invoke("limbo.apiApprovalGet", { requestId }) as Promise<ApiApprovalRequest | null>,
    decide: (payload) => {
      void fenestra.bridge.invoke("limbo.apiApprovalDecision", payload);
    },
  };
}

export function approvalRequestIdFromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("id");
  } catch {
    return null;
  }
}

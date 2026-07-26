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
  if (typeof window === "undefined") return null;
  const requireFn = (
    window as Window & {
      require?: (id: string) => { ipcRenderer: ApiApprovalIpc };
    }
  ).require;
  if (!requireFn) return null;
  try {
    const { ipcRenderer } = requireFn("electron");
    return {
      getRequest: (requestId) =>
        ipcRenderer.invoke("limbo-api-approval-get", requestId) as Promise<ApiApprovalRequest | null>,
      decide: (payload) => {
        ipcRenderer.send("limbo-api-approval-decision", payload);
      },
    };
  } catch {
    return null;
  }
}

type ApiApprovalIpc = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  send: (channel: string, ...args: unknown[]) => void;
};

export function approvalRequestIdFromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("id");
  } catch {
    return null;
  }
}

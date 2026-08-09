type SabineGuestBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type SabineGuestCreateOptions = {
  id?: string;
  url?: string;
  html?: string;
  bounds: SabineGuestBounds;
  partition?: string;
  allowBridge?: boolean;
  interceptedShortcuts?: string[];
  interceptHorizontalWheel?: boolean;
  visible?: boolean;
  popupPolicy?: string;
  allowDownloads?: boolean;
  backgroundColor?: string;
};

type SabineGuestInfo = {
  id: string;
  url?: string;
  title?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  loading?: boolean;
};

type SabineApi = {
  window: {
    focus: () => void;
    minimize: () => void;
    maximize: () => void;
    toggleMaximize: () => void;
    close: () => void;
  };
  bridge: {
    readonly __native: true;
    readonly commands: string[];
    invoke: (name: string, params?: Record<string, unknown>) => Promise<unknown>;
    listen: (name: string, callback: (payload: unknown) => void) => () => void;
  };
  guest?: {
    create: (options: SabineGuestCreateOptions) => Promise<{ id: string } | string | unknown>;
    destroy: (id: string) => Promise<unknown>;
    navigate: (id: string, url: string) => Promise<unknown>;
    setBounds: (id: string, bounds: SabineGuestBounds) => Promise<unknown>;
    setVisible: (id: string, visible: boolean) => Promise<unknown>;
    setCovered: (covered: boolean) => Promise<unknown>;
    capturePreview: (id: string) => Promise<unknown>;
    focus: (id: string) => Promise<unknown>;
    reload: (id: string, options?: { ignoreCache?: boolean }) => Promise<unknown>;
    goBack: (id: string) => Promise<unknown>;
    goForward: (id: string) => Promise<unknown>;
    get: (id: string) => Promise<SabineGuestInfo | null | unknown>;
    downloadAction: (
      downloadId: string,
      action: string,
      options?: { savePath?: string }
    ) => Promise<unknown>;
  };
};

declare global {
  interface Window {
    sabine?: SabineApi;
  }
}

export {};

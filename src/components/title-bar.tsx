import type { MouseEvent } from "react";
import { Minus, Square, X } from "lucide-react";
import { appWindow } from "@lantharos/sabine";

const usesNativeMacChrome = /Macintosh|Mac OS X/i.test(navigator.userAgent);

function windowAction(action: () => void) {
  return (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    action();
  };
}

export function TitleBar() {
  if (usesNativeMacChrome) return null;

  return (
    <div className="flex h-10 select-none items-center justify-between bg-neutral-900 app-drag">
      <div className="flex items-center gap-2 px-4">
        <span className="text-sm font-medium text-neutral-200">Limbo</span>
      </div>

      <div className="flex app-no-drag">
        <button
          type="button"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={windowAction(() => appWindow.minimize())}
          className="flex h-10 w-12 items-center justify-center transition-colors hover:bg-neutral-800"
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={windowAction(() => appWindow.toggleMaximize())}
          className="flex h-10 w-12 items-center justify-center transition-colors hover:bg-neutral-800"
        >
          <Square className="h-3 w-3" />
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={windowAction(() => appWindow.hide())}
          className="flex h-10 w-12 items-center justify-center transition-colors hover:bg-red-600"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

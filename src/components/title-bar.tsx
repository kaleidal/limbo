import type { MouseEvent } from "react";
import { Minus, Square, X } from "lucide-react";

export function TitleBar() {
  const handleMinimize = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    window.limbo?.minimize();
  };
  const handleMaximize = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    window.limbo?.maximize();
  };
  const handleClose = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    window.limbo?.close();
  };

  return (
    <div className="flex h-10 select-none items-center justify-between bg-neutral-900 app-drag">
      <div className="flex items-center gap-2 px-4">
        <span className="text-sm font-medium text-neutral-200">Limbo</span>
      </div>

      <div className="flex app-no-drag">
        <button
          type="button"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={handleMinimize}
          className="flex h-10 w-12 items-center justify-center transition-colors hover:bg-neutral-800"
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={handleMaximize}
          className="flex h-10 w-12 items-center justify-center transition-colors hover:bg-neutral-800"
        >
          <Square className="h-3 w-3" />
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={handleClose}
          className="flex h-10 w-12 items-center justify-center transition-colors hover:bg-red-600"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

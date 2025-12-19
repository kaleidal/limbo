import { Minus, Square, X } from "lucide-react";

export function TitleBar() {
  const handleMinimize = () => window.limbo?.minimize();
  const handleMaximize = () => window.limbo?.maximize();
  const handleClose = () => window.limbo?.close();

  return (
    <div className="flex items-center justify-between h-10 bg-neutral-900 border-b border-neutral-800 select-none app-drag">
      <div className="flex items-center gap-2 px-4">
        <span className="text-sm font-medium text-neutral-200">Limbo</span>
      </div>

      <div className="flex app-no-drag">
        <button
          onClick={handleMinimize}
          className="w-12 h-10 flex items-center justify-center hover:bg-neutral-800 transition-colors"
        >
          <Minus className="w-4 h-4" />
        </button>
        <button
          onClick={handleMaximize}
          className="w-12 h-10 flex items-center justify-center hover:bg-neutral-800 transition-colors"
        >
          <Square className="w-3 h-3" />
        </button>
        <button
          onClick={handleClose}
          className="w-12 h-10 flex items-center justify-center hover:bg-red-600 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

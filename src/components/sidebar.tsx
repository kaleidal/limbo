import { useState } from "react";
import { useAppStore } from "@/store/app-store";
import { useOccludeGuest } from "@/hooks/use-occlude-guest";
import {
  Library,
  Download,
  Plus,
  Settings,
  Globe,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Bookmark } from "@/types/electron.d";

export function Sidebar() {
  const {
    currentView,
    setCurrentView,
    bookmarks,
    activeBookmark,
    setActiveBookmark,
    setIsAddBookmarkOpen,
    downloads,
    torrents,
  } = useAppStore();

  const [hoveredBookmark, setHoveredBookmark] = useState<string | null>(null);
  const [editingBookmark, setEditingBookmark] = useState<Bookmark | null>(null);
  const [editUrl, setEditUrl] = useState("");
  const [editName, setEditName] = useState("");
  useOccludeGuest(!!editingBookmark);

  const handleEditBookmark = (bookmark: Bookmark) => {
    setEditingBookmark(bookmark);
    setEditUrl(bookmark.url);
    setEditName(bookmark.name);
  };

  const handleSaveEdit = async () => {
    if (!editingBookmark || !window.limbo) return;
    const updated = await window.limbo.updateBookmark({
      ...editingBookmark,
      url: editUrl,
      name: editName,
      favicon: `https://www.google.com/s2/favicons?domain=${new URL(editUrl.startsWith('http') ? editUrl : 'https://' + editUrl).hostname}&sz=64`,
    });
    useAppStore.getState().setBookmarks(updated);
    setEditingBookmark(null);
  };

  const activeDownloads = downloads.filter(
    (d) => d.status === "downloading" || d.status === "pending"
  );

  const activeTorrents = torrents.filter(
    (t) => t.status === "downloading" || t.status === "paused"
  );

  const activeTransfersCount = activeDownloads.length + activeTorrents.length;

  const handleRemoveBookmark = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (window.limbo) {
      const updated = await window.limbo.removeBookmark(id);
      useAppStore.getState().setBookmarks(updated);
      if (activeBookmark?.id === id) {
        setActiveBookmark(null);
        setCurrentView("library");
      }
    }
  };

  return (
    <aside className="app-drag flex w-16 flex-col items-center gap-2 overflow-hidden border-r border-neutral-800 bg-neutral-900 py-4">
      {/* Main navigation */}
      <NavButton
        icon={<Library className="w-5 h-5" />}
        isActive={currentView === "library"}
        onClick={() => {
          setActiveBookmark(null);
          setCurrentView("library");
        }}
        tooltip="Library"
      />

      <NavButton
        icon={
          <div className="relative">
            <Download className="w-5 h-5" />
            {activeTransfersCount > 0 && (
              <span className={cn(
                "absolute -top-1 -right-1 w-4 h-4 text-xs font-bold rounded-full flex items-center justify-center",
                currentView === "downloads"
                  ? "bg-neutral-900 text-lime-500 ring-1 ring-lime-500"
                  : "bg-lime-500 text-neutral-900"
              )}>
                {activeTransfersCount}
              </span>
            )}
          </div>
        }
        isActive={currentView === "downloads"}
        onClick={() => {
          setActiveBookmark(null);
          setCurrentView("downloads");
        }}
        tooltip="Downloads"
      />

      <div className="my-2 h-px w-8 bg-neutral-700" />

      {/* Bookmarks */}
      <div className="scrollbar-none flex w-full flex-1 flex-col items-center gap-2 overflow-x-hidden overflow-y-auto px-2 pt-1">
        {bookmarks.map((bookmark) => (
          <div
            key={bookmark.id}
            className="app-no-drag relative flex-shrink-0"
            onMouseEnter={() => setHoveredBookmark(bookmark.id)}
            onMouseLeave={() => setHoveredBookmark(null)}
          >
            <button
              onClick={() => setActiveBookmark(bookmark)}
              onContextMenu={(e) => {
                e.preventDefault();
                handleEditBookmark(bookmark);
              }}
              className={cn(
                "flex h-12 w-12 items-center justify-center overflow-hidden rounded-lg transition-all",
                activeBookmark?.id === bookmark.id
                  ? "bg-lime-500/20 ring-2 ring-lime-500"
                  : "bg-neutral-800 hover:bg-neutral-700"
              )}
              title={`${bookmark.name} (right-click to edit)`}
            >
              {bookmark.favicon ? (
                <img
                  src={bookmark.favicon}
                  alt={bookmark.name}
                  className="h-6 w-6 object-contain"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                    (e.target as HTMLImageElement).nextElementSibling?.classList.remove("hidden");
                  }}
                />
              ) : null}
              <Globe
                className={cn("h-5 w-5 text-neutral-400", bookmark.favicon && "hidden")}
              />
            </button>
            {hoveredBookmark === bookmark.id && (
              <button
                onClick={(e) => handleRemoveBookmark(e, bookmark.id)}
                className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 transition-colors hover:bg-red-600"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}

        {/* Add bookmark button */}
        <button
          onClick={() => setIsAddBookmarkOpen(true)}
          className="app-no-drag flex h-12 w-12 items-center justify-center rounded-lg border-2 border-dashed border-neutral-700 text-neutral-500 transition-colors hover:border-lime-500 hover:text-lime-500"
        >
          <Plus className="h-5 w-5" />
        </button>
      </div>

      {/* Settings */}
      <div className="my-2 h-px w-8 bg-neutral-700" />
      <NavButton
        icon={<Settings className="w-5 h-5" />}
        isActive={currentView === "settings"}
        onClick={() => {
          setActiveBookmark(null);
          setCurrentView("settings");
        }}
        tooltip="Settings"
      />

      {/* Edit Bookmark Modal */}
      {editingBookmark && (
        <div className="app-no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditingBookmark(null)}>
          <div className="w-96 rounded-lg border border-neutral-800 bg-neutral-900 p-6" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">Edit Bookmark</h3>
              <button
                onClick={() => setEditingBookmark(null)}
                className="rounded p-1 transition-colors hover:bg-neutral-800"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <Label htmlFor="edit-name">Name</Label>
                <Input
                  id="edit-name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="mt-1 border-neutral-700 bg-neutral-800"
                />
              </div>
              <div>
                <Label htmlFor="edit-url">URL</Label>
                <Input
                  id="edit-url"
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  className="mt-1 border-neutral-700 bg-neutral-800"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditingBookmark(null)}>
                Cancel
              </Button>
              <Button onClick={handleSaveEdit}>
                Save
              </Button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function NavButton({
  icon,
  isActive,
  onClick,
  tooltip,
}: {
  icon: React.ReactNode;
  isActive: boolean;
  onClick: () => void;
  tooltip: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "app-no-drag flex h-12 w-12 items-center justify-center rounded-lg transition-all",
        isActive
          ? "bg-lime-500 text-neutral-900"
          : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200"
      )}
      title={tooltip}
    >
      {icon}
    </button>
  );
}

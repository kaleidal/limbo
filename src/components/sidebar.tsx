import { useState } from "react";
import { useAppStore } from "@/store/app-store";
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
    <aside className="w-16 bg-neutral-900 border-r border-neutral-800 flex flex-col items-center py-4 gap-2 overflow-hidden">
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

      <div className="w-8 h-px bg-neutral-700 my-2" />

      {/* Bookmarks */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden w-full flex flex-col items-center gap-2 px-2 pt-1 scrollbar-none">
        {bookmarks.map((bookmark) => (
          <div
            key={bookmark.id}
            className="relative flex-shrink-0"
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
                "w-12 h-12 rounded-lg flex items-center justify-center transition-all overflow-hidden",
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
                  className="w-6 h-6 object-contain"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                    (e.target as HTMLImageElement).nextElementSibling?.classList.remove("hidden");
                  }}
                />
              ) : null}
              <Globe
                className={cn("w-5 h-5 text-neutral-400", bookmark.favicon && "hidden")}
              />
            </button>
            {hoveredBookmark === bookmark.id && (
              <button
                onClick={(e) => handleRemoveBookmark(e, bookmark.id)}
                className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center hover:bg-red-600 transition-colors"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}

        {/* Add bookmark button */}
        <button
          onClick={() => setIsAddBookmarkOpen(true)}
          className="w-12 h-12 rounded-lg border-2 border-dashed border-neutral-700 flex items-center justify-center hover:border-lime-500 hover:text-lime-500 transition-colors text-neutral-500"
        >
          <Plus className="w-5 h-5" />
        </button>
      </div>

      {/* Settings */}
      <div className="w-8 h-px bg-neutral-700 my-2" />
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setEditingBookmark(null)}>
          <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-6 w-96" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Edit Bookmark</h3>
              <button
                onClick={() => setEditingBookmark(null)}
                className="p-1 hover:bg-neutral-800 rounded transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <Label htmlFor="edit-name">Name</Label>
                <Input
                  id="edit-name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="mt-1 bg-neutral-800 border-neutral-700"
                />
              </div>
              <div>
                <Label htmlFor="edit-url">URL</Label>
                <Input
                  id="edit-url"
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  className="mt-1 bg-neutral-800 border-neutral-700"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
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
        "w-12 h-12 rounded-lg flex items-center justify-center transition-all",
        isActive
          ? "bg-lime-500 text-neutral-900"
          : "bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200"
      )}
      title={tooltip}
    >
      {icon}
    </button>
  );
}

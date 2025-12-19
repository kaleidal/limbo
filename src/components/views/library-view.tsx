import { useState, useMemo } from "react";
import { useAppStore } from "@/store/app-store";
import {
  Search,
  Grid,
  List,
  FolderOpen,
  Play,
  Trash2,
  Plus,
  HardDrive,
  Film,
  Gamepad2,
  Archive,
  FileQuestion,
  Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Category = "all" | "videos" | "games" | "archives" | "other";

const CATEGORIES: { id: Category; label: string; icon: typeof Film }[] = [
  { id: "all", label: "All", icon: Layers },
  { id: "videos", label: "Videos", icon: Film },
  { id: "games", label: "Games & Software", icon: Gamepad2 },
  { id: "archives", label: "Archives", icon: Archive },
  { id: "other", label: "Other", icon: FileQuestion },
];

const VIDEO_EXTENSIONS = [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".mpg", ".mpeg"];
const GAME_EXTENSIONS = [".exe", ".msi", ".iso", ".img", ".bin", ".cue", ".nrg", ".dmg", ".pkg", ".app"];
const ARCHIVE_EXTENSIONS = [".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".cab"];

function getFileCategory(name: string): Category {
  const lowerName = name.toLowerCase();
  
  // Check for multi-part archives (e.g., .part1.rar, .part2.rar)
  if (/\.part\d+\.(rar|zip|7z)$/i.test(lowerName) || /\.(r\d{2}|z\d{2})$/i.test(lowerName)) {
    return "archives";
  }
  
  for (const ext of VIDEO_EXTENSIONS) {
    if (lowerName.endsWith(ext)) return "videos";
  }
  for (const ext of GAME_EXTENSIONS) {
    if (lowerName.endsWith(ext)) return "games";
  }
  for (const ext of ARCHIVE_EXTENSIONS) {
    if (lowerName.endsWith(ext)) return "archives";
  }
  return "other";
}

function getCategoryIcon(category: Category) {
  switch (category) {
    case "videos": return Film;
    case "games": return Gamepad2;
    case "archives": return Archive;
    default: return FolderOpen;
  }
}

export function LibraryView() {
  const { library, searchQuery, setSearchQuery } = useAppStore();
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<Category>("all");

  // Calculate category counts
  const categoryCounts = useMemo(() => {
    const counts: Record<Category, number> = { all: library.length, videos: 0, games: 0, archives: 0, other: 0 };
    library.forEach((item) => {
      const cat = getFileCategory(item.name);
      counts[cat]++;
    });
    return counts;
  }, [library]);

  const filteredLibrary = useMemo(() => {
    return library.filter((item) => {
      const matchesSearch = item.name.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesCategory = activeCategory === "all" || getFileCategory(item.name) === activeCategory;
      return matchesSearch && matchesCategory;
    });
  }, [library, searchQuery, activeCategory]);

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const handleOpenLocation = async (path: string) => {
    if (window.limbo) {
      await window.limbo.openFileLocation(path);
    }
  };

  const handleOpenFile = async (path: string) => {
    if (window.limbo) {
      await window.limbo.openFile(path);
    }
  };

  const handleRemove = async (id: string, deleteFiles: boolean) => {
    if (window.limbo) {
      const updated = await window.limbo.removeFromLibrary(id, deleteFiles);
      useAppStore.getState().setLibrary(updated);
    }
  };

  const handleAddFolder = async () => {
    if (window.limbo) {
      const item = await window.limbo.addFolderToLibrary();
      if (item) {
        useAppStore.getState().addToLibrary(item);
      }
    }
  };

  const iconColors: Record<Category, string> = {
    videos: "text-blue-500",
    games: "text-purple-500",
    archives: "text-amber-500",
    other: "text-neutral-500",
    all: "text-neutral-500",
  };

  return (
    <div className="h-full flex flex-col p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Library</h1>
        <div className="flex items-center gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
            <Input
              placeholder="Search library..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 w-64 bg-neutral-900 border-neutral-700"
            />
          </div>
          <div className="flex items-center gap-1 bg-neutral-900 rounded-lg p-1">
            <button
              onClick={() => setViewMode("grid")}
              className={cn(
                "p-2 rounded",
                viewMode === "grid"
                  ? "bg-neutral-700 text-white"
                  : "text-neutral-500 hover:text-white"
              )}
            >
              <Grid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode("list")}
              className={cn(
                "p-2 rounded",
                viewMode === "list"
                  ? "bg-neutral-700 text-white"
                  : "text-neutral-500 hover:text-white"
              )}
            >
              <List className="w-4 h-4" />
            </button>
          </div>
          <Button onClick={handleAddFolder} className="gap-2">
            <Plus className="w-4 h-4" />
            Add Folder
          </Button>
        </div>
      </div>

      {/* Category Tabs */}
      <div className="flex items-center gap-2 mb-6 border-b border-neutral-800 pb-4">
        {CATEGORIES.map((cat) => {
          const Icon = cat.icon;
          const count = categoryCounts[cat.id];
          return (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg transition-all",
                activeCategory === cat.id
                  ? "bg-lime-500 text-neutral-900 font-medium"
                  : "bg-neutral-900 text-neutral-400 hover:text-white hover:bg-neutral-800"
              )}
            >
              <Icon className="w-4 h-4" />
              <span>{cat.label}</span>
              <span className={cn(
                "text-xs px-1.5 py-0.5 rounded",
                activeCategory === cat.id
                  ? "bg-neutral-900/30 text-neutral-900"
                  : "bg-neutral-700 text-neutral-400"
              )}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      {filteredLibrary.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-neutral-500">
          <HardDrive className="w-16 h-16 mb-4" />
          <p className="text-lg">
            {activeCategory === "all" ? "Your library is empty" : `No ${CATEGORIES.find(c => c.id === activeCategory)?.label.toLowerCase()} found`}
          </p>
          <p className="text-sm">
            Downloads will appear here, or add existing folders
          </p>
        </div>
      ) : viewMode === "grid" ? (
        <div className="flex-1 overflow-auto">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {filteredLibrary.map((item) => {
              const category = getFileCategory(item.name);
              const ItemIcon = getCategoryIcon(category);
              
              return (
                <div
                  key={item.id}
                  className={cn(
                    "bg-neutral-900 rounded-lg overflow-hidden group cursor-pointer transition-all",
                    selectedItem === item.id && "ring-2 ring-lime-500"
                  )}
                  onClick={() => setSelectedItem(item.id)}
                  onDoubleClick={() => handleOpenFile(item.path)}
                >
                  <div className="aspect-video bg-neutral-800 flex items-center justify-center relative">
                    <ItemIcon className={cn("w-12 h-12", iconColors[category])} />
                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenFile(item.path);
                        }}
                        className="p-2 bg-lime-500 rounded-full hover:bg-lime-400 transition-colors"
                      >
                        <Play className="w-5 h-5 text-neutral-900" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenLocation(item.path);
                        }}
                        className="p-2 bg-neutral-700 rounded-full hover:bg-neutral-600 transition-colors"
                      >
                        <FolderOpen className="w-5 h-5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemove(item.id, false);
                        }}
                        className="p-2 bg-red-500 rounded-full hover:bg-red-400 transition-colors"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                  <div className="p-3">
                    <h3 className="font-medium truncate" title={item.name}>
                      {item.name}
                    </h3>
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-neutral-500">
                        {formatSize(item.size)}
                      </p>
                      <span className={cn("text-xs px-1.5 py-0.5 rounded", {
                        "bg-blue-500/20 text-blue-400": category === "videos",
                        "bg-purple-500/20 text-purple-400": category === "games",
                        "bg-amber-500/20 text-amber-400": category === "archives",
                        "bg-neutral-500/20 text-neutral-400": category === "other",
                      })}>
                        {category === "games" ? "Software" : category.charAt(0).toUpperCase() + category.slice(1)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full">
            <thead className="bg-neutral-900 sticky top-0">
              <tr className="text-left text-sm text-neutral-500">
                <th className="p-3">Name</th>
                <th className="p-3">Category</th>
                <th className="p-3">Size</th>
                <th className="p-3">Date Added</th>
                <th className="p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredLibrary.map((item) => {
                const category = getFileCategory(item.name);
                const ItemIcon = getCategoryIcon(category);
                
                return (
                  <tr
                    key={item.id}
                    className={cn(
                      "border-b border-neutral-800 hover:bg-neutral-900 cursor-pointer",
                      selectedItem === item.id && "bg-neutral-800"
                    )}
                    onClick={() => setSelectedItem(item.id)}
                    onDoubleClick={() => handleOpenFile(item.path)}
                  >
                    <td className="p-3">
                      <div className="flex items-center gap-3">
                        <ItemIcon className={cn("w-5 h-5", iconColors[category])} />
                        <span className="truncate max-w-md" title={item.name}>
                          {item.name}
                        </span>
                      </div>
                    </td>
                    <td className="p-3">
                      <span className={cn("text-xs px-2 py-1 rounded", {
                        "bg-blue-500/20 text-blue-400": category === "videos",
                        "bg-purple-500/20 text-purple-400": category === "games",
                        "bg-amber-500/20 text-amber-400": category === "archives",
                        "bg-neutral-500/20 text-neutral-400": category === "other",
                      })}>
                        {category === "games" ? "Software" : category.charAt(0).toUpperCase() + category.slice(1)}
                      </span>
                    </td>
                    <td className="p-3 text-neutral-400">{formatSize(item.size)}</td>
                    <td className="p-3 text-neutral-400">
                      {formatDate(item.dateAdded)}
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenFile(item.path);
                          }}
                          className="p-1.5 hover:bg-neutral-700 rounded transition-colors"
                          title="Open"
                        >
                          <Play className="w-4 h-4" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenLocation(item.path);
                          }}
                          className="p-1.5 hover:bg-neutral-700 rounded transition-colors"
                          title="Open folder"
                        >
                          <FolderOpen className="w-4 h-4" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemove(item.id, false);
                          }}
                          className="p-1.5 hover:bg-red-500/20 text-red-500 rounded transition-colors"
                          title="Remove"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

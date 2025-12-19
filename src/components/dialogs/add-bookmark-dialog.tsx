import { useState } from "react";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X, Globe, Loader2 } from "lucide-react";

export function AddBookmarkDialog() {
  const { isAddBookmarkOpen, setIsAddBookmarkOpen, addBookmark } = useAppStore();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const extractDomain = (url: string) => {
    try {
      const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
      return urlObj.hostname.replace("www.", "");
    } catch {
      return url;
    }
  };

  const getFaviconUrl = (url: string) => {
    try {
      const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
      return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=64`;
    } catch {
      return "";
    }
  };

  const handleUrlChange = (value: string) => {
    setUrl(value);
    if (!name) {
      setName(extractDomain(value));
    }
  };

  const handleAdd = async () => {
    if (!url.trim()) return;

    setIsLoading(true);
    try {
      const fullUrl = url.startsWith("http") ? url : `https://${url}`;
      const favicon = getFaviconUrl(fullUrl);

      if (window.limbo) {
        const newBookmark = await window.limbo.addBookmark({
          name: name || extractDomain(url),
          url: fullUrl,
          favicon,
        });
        addBookmark(newBookmark);
      }

      setUrl("");
      setName("");
      setIsAddBookmarkOpen(false);
    } catch (error) {
      console.error("Failed to add bookmark:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    setUrl("");
    setName("");
    setIsAddBookmarkOpen(false);
  };

  if (!isAddBookmarkOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-neutral-900 rounded-lg border border-neutral-800 w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Add Site</h2>
          <button
            onClick={handleClose}
            className="p-1 hover:bg-neutral-800 rounded transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <Label htmlFor="site-url">URL</Label>
            <div className="relative mt-1">
              <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
              <Input
                id="site-url"
                value={url}
                onChange={(e) => handleUrlChange(e.target.value)}
                placeholder="https://example.com"
                className="pl-10 bg-neutral-800 border-neutral-700"
                autoFocus
              />
            </div>
          </div>

          <div>
            <Label htmlFor="site-name">Name (optional)</Label>
            <Input
              id="site-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Site name"
              className="mt-1 bg-neutral-800 border-neutral-700"
            />
          </div>

          {url && (
            <div className="flex items-center gap-3 p-3 bg-neutral-800 rounded-lg">
              <img
                src={getFaviconUrl(url)}
                alt=""
                className="w-8 h-8"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
              <div>
                <p className="font-medium">{name || extractDomain(url)}</p>
                <p className="text-sm text-neutral-500 truncate">
                  {url.startsWith("http") ? url : `https://${url}`}
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleAdd} disabled={!url.trim() || isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Adding...
              </>
            ) : (
              "Add Site"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

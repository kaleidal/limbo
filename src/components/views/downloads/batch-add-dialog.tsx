import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function BatchAddDialog({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (urls: string[]) => void;
}) {
  const [input, setInput] = useState("");

  const handleSubmit = () => {
    const urls = input.split("\n").map((line) => line.trim()).filter(Boolean);
    if (urls.length > 0) onAdd(urls);
    onClose();
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-8">
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-2xl p-6 w-full max-w-lg">
        <h3 className="text-xl font-bold mb-4">Add several downloads</h3>
        <Textarea
          placeholder="Paste links here, one per line"
          className="min-h-[200px] mb-4 bg-neutral-950 border-neutral-800 font-mono text-xs"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit}>Add links</Button>
        </div>
      </div>
    </div>
  );
}

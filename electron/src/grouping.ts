// Utility for grouping downloads
import path from "path";

export function getGroupName(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const name = path.basename(filename, ext);

    // Pattern: Name.part1.rar
    const partMatch = name.match(/^(.+)\.part\d+$/i);
    if (partMatch) {
        return partMatch[1].replace(/[._-]$/, "").trim();
    }

    // Pattern: Name.r00
    const rMatch = name.match(/^(.+)\.r\d{2,}$/i);
    if (rMatch) {
        return rMatch[1].replace(/[._-]$/, "").trim();
    }

    // Pattern: Name.001 (7z split)
    const numMatch = name.match(/^(.+)\.\d{3}$/i);
    if (numMatch) {
        return numMatch[1].replace(/[._-]$/, "").trim();
    }

    // General heuristic: Clean up common suffixes
    // e.g. "My.Game.v1.0.Repack-Group" -> "My Game v1.0"
    // This is subjective, for now let's just use the filename if not a multipart
    return name;
}

export function getGroupId(filename: string): string {
    // Simple slug from group name
    const name = getGroupName(filename);
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

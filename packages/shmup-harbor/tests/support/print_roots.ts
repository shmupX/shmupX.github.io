// What repo-root.ts answers in a fresh process — the only way to see past its
// per-process cache, and the shape the packaged app and the Node half see.
import { harborRoot, repoRoot } from "../../lib/repo-root.ts";

console.log(JSON.stringify({ repo: repoRoot(), harbor: harborRoot() }));

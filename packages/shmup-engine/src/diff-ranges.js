// Coalesce the byte offsets where two buffers differ into [start, end]
// ranges (inclusive), merging runs separated by fewer than `minGap`
// identical bytes so a single struct doesn't fragment into noise.
//
// Shared by dev/diff-saves.js and the emulator-capture regression tests.

export function coalesceDiffRanges(a, b, minGap = 8) {
    const n = Math.min(a.length, b.length);
    const ranges = [];
    let runStart = -1;
    let lastDiff = -1;
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) {
            if (runStart === -1) runStart = i;
            else if (i - lastDiff > minGap) {
                ranges.push([runStart, lastDiff]);
                runStart = i;
            }
            lastDiff = i;
        }
    }
    if (runStart !== -1) ranges.push([runStart, lastDiff]);
    return ranges;
}

export function totalDiffBytes(ranges) {
    let total = 0;
    for (const [s, e] of ranges) total += e - s + 1;
    return total;
}

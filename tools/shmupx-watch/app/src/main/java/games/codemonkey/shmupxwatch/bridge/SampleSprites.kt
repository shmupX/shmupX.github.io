package games.codemonkey.shmupxwatch.bridge

/**
 * Two 16x16 frames used by [FakeBridge] so the preview screen has something to
 * draw before the MCP is wired up. Same shape the real tool returns: bare
 * base64 PNG, no data-URI prefix.
 */
internal object SampleSprites {

    private const val FRAME_A =
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAnUlEQVR42mNgwAPyX+T/z3+R" +
        "/x+fGiYGCgELPtsf3M6Cshn+T5SYyEgTFzDhsp0YMdq44P8GBpyhjk2OBZ8CBdVpWA1hDGBg" +
        "xHABTHOBRT5c8cZJZxk2TjoL58PkkC1C8QK6ZmxsZDUoBiA7ixDA6gUGBgYGXImFVDUM+S/y" +
        "///vsYH7E8ZWqLIhmDcQoa0X/R8bm/iEFPcQO5vaAAAk7UkaGOBuNQAAAABJRU5ErkJggg=="

    private const val FRAME_B =
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAlklEQVR42mNgwAPyX+T/z3+R" +
        "/x+fGiYGCgELPtsf3M6Cshn+T5SYyEgTFzDhsp0YMdq44P8GBpyhjk2OBZ8CBdVpWA1hDGBg" +
        "xHABTHOBRT5c8cZJZxk2TjoL58PkkC1C8QK6ZmxsZDUoBiA7ixDA6gUGBgYGXImFVDUM+S/y" +
        "///Xi4b7E8ZWqLIhmDcQod1j8x8be/ABABFiRpqIHc5KAAAAAElFTkSuQmCC"

    private val frames = listOf(FRAME_A, FRAME_B)
    private var index = 0

    fun next(): String {
        val frame = frames[index % frames.size]
        index++
        return frame
    }
}

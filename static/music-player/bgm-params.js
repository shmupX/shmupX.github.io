// The album a host names on the player's URL.
//
//   /music-player/?bgm=https://cdn.example/stage1.mp3&bgm=https://cdn.example/boss.mp3
//                 &title=Stage%201&title=Boss&album=My%20Game&autoplay=1
//
// `bgm` (also `bgmURL` / `bgmUrl`) repeats once per track; `title` repeats
// beside it, in the same order, and is optional — a missing one is read off
// the file name. `album` names the album; `autoplay=1` asks for the first
// track to start (a browser refuses that until the page has been tapped, in
// which case the deck parks on "Tap Play to start").
//
// A URL is a capability, so the list is checked rather than passed through:
// only http(s) and blob URLs are kept (resolved against the page), the rest
// are dropped, and a run-away list is cut at MAX_TRACKS.
//
// Written as a classic script for the player page, which has no modules, and
// read by Deno for tests/music_player_test.ts off the same global.
(function (root) {
  "use strict";

  var MAX_TRACKS = 200;
  var MAX_TEXT = 120;

  /** The absolute form of a track URL the player may load, or null. */
  function bgmUrlAllowed(raw, base) {
    if (typeof raw !== "string" || !raw.trim()) return null;
    var url;
    try {
      url = new URL(raw.trim(), base || "https://localhost/");
    } catch (_e) {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "blob:") {
      return null;
    }
    return url.href;
  }

  function text(value, fallback) {
    var s = typeof value === "string" ? value.trim() : "";
    return (s || fallback || "").slice(0, MAX_TEXT);
  }

  /** "Stage 1" out of ".../stage_1.mp3". */
  function titleFromUrl(href) {
    var name = "";
    try {
      var path = new URL(href).pathname;
      name = decodeURIComponent(path.split("/").pop() || "");
    } catch (_e) {
      name = "";
    }
    name = name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    return name || "Track";
  }

  /** A stable id for a track: its file name, made unique within the album. */
  function trackId(href, index, taken) {
    var base = "";
    try {
      base = decodeURIComponent(new URL(href).pathname.split("/").pop() || "");
    } catch (_e) {
      base = "";
    }
    base = base.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64) ||
      "track-" + (index + 1);
    var id = base;
    var n = 2;
    while (taken[id]) id = base + "-" + n++;
    taken[id] = true;
    return id;
  }

  /**
   * The album the query names, or null when it names no track.
   * `params` is a URLSearchParams; `base` is the page URL relative paths
   * resolve against.
   */
  function albumFromParams(params, base) {
    if (!params || typeof params.getAll !== "function") return null;
    var raw = [].concat(params.getAll("bgm"), params.getAll("bgmURL"), params.getAll("bgmUrl"));
    var titles = params.getAll("title");
    var tracks = [];
    var taken = {};
    for (var i = 0; i < raw.length && tracks.length < MAX_TRACKS; i += 1) {
      var href = bgmUrlAllowed(raw[i], base);
      if (!href) continue;
      tracks.push({
        id: trackId(href, i, taken),
        title: text(titles[i], titleFromUrl(href)),
        url: href,
      });
    }
    if (!tracks.length) return null;
    var albumTitle = text(params.get("album"), "Game BGM");
    return {
      id: "url:" + albumTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      title: albumTitle,
      tracks: tracks,
      autoplay: params.get("autoplay") === "1",
    };
  }

  root.MusicPlayerBgmParams = {
    MAX_TRACKS: MAX_TRACKS,
    bgmUrlAllowed: bgmUrlAllowed,
    titleFromUrl: titleFromUrl,
    albumFromParams: albumFromParams,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

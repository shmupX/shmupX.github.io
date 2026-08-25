/**
 * SpriteShare — Cordova JS module
 *
 * Provides a method for the main app to check whether the share Activity
 * has saved a repacked atlas, so the game can reload it on resume.
 */
var SpriteShare = {
  /**
   * Check if a repacked atlas exists in internal storage.
   * The share Activity saves repacked atlases with the _ prefix
   * (e.g. _game_asset.png / _game_asset.json).
   *
   * @param {string} atlasName - e.g. "game_asset"
   * @param {function} successCb - called with true/false
   * @param {function} errorCb - called on failure
   */
  hasRepackedAtlas: function (atlasName, successCb, errorCb) {
    // When running inside the main Cordova WebView, the Android bridge
    // is not available (it's only injected in SpriteShareActivity's WebView).
    // Instead we check via a simple XHR to the internal files path.
    // For now, this is a no-op stub — the game's existing _game_asset
    // detection in BootScene.js handles it via the ea.game_asset flag.
    if (successCb) successCb(false);
  }
};

module.exports = SpriteShare;

var exec = require("cordova/exec");

var SERVICE = "IOSHaptics";

/**
 * Thin JS wrapper that exposes window.TapticEngine.
 *
 * Method signatures intentionally match the cordova-plugin-taptic-engine
 * conventions so the existing haptics.js integration works unchanged.
 */
var IOSHaptics = {
    /**
     * Trigger impact feedback.
     * @param {Object|string} opts  - { style: 'light'|'medium'|'heavy'|'soft'|'rigid' } or just the style string
     * @param {Function} [success]
     * @param {Function} [error]
     */
    impact: function (opts, success, error) {
        exec(success || function () {}, error || function () {}, SERVICE, "impact", [opts]);
    },

    /**
     * Trigger notification feedback.
     * @param {Object|string} opts  - { type: 'success'|'warning'|'error' } or just the type string
     * @param {Function} [success]
     * @param {Function} [error]
     */
    notification: function (opts, success, error) {
        exec(success || function () {}, error || function () {}, SERVICE, "notification", [opts]);
    },

    /**
     * Trigger selection feedback.
     * @param {Function} [success]
     * @param {Function} [error]
     */
    selection: function (success, error) {
        exec(success || function () {}, error || function () {}, SERVICE, "selection", []);
    }
};

module.exports = IOSHaptics;

#!/usr/bin/env node

/**
 * Cordova after_prepare hook
 *
 * iOS: makes the WKWebView inspectable (Safari / chrome://inspect).
 * Android: scrubs files earlier versions of this hook left in the platform
 * directory (a stub SpriteShareActivity.java, a ForgeApplication reference on
 * <application>).
 *
 * Immersive mode is not this hook's: config.xml's Fullscreen preference makes
 * CordovaActivity hide both system bars (IMMERSIVE_STICKY) in onCreate and
 * again whenever the window regains focus. This hook used to patch a
 * MainActivity.kt with its own immersive mode and launch diagnostics (a Toast
 * and a non-cancelable log dialog on every launch, logs in the public
 * Downloads folder). cordova-android 13 and 14 write MainActivity.java, so it
 * found nothing to patch and none of it ever ran; it is gone rather than
 * ported, since a shipped game has no use for any of it.
 *
 * Note: SpriteShareActivity (for receiving shared images) is installed by
 * the cordova-plugin-sprite-share plugin via plugin.xml, not by this hook.
 */

const fs   = require("fs");
const path = require("path");

/** Recursively search for a file by name under `dir`. */
function findFile(dir, filename) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (_) { return null; }

    for (const entry of entries) {
        const full = path.join(dir, entry);
        let stat;
        try { stat = fs.statSync(full); } catch (_) { continue; }

        if (stat.isDirectory()) {
            const found = findFile(full, filename);
            if (found) return found;
        } else if (entry === filename) {
            return full;
        }
    }
    return null;
}

function patchIOSWebViewInspectable(context) {
    const platformRoot = path.join(
        context.opts.projectRoot, "platforms", "ios"
    );
    if (!fs.existsSync(platformRoot)) return;

    // Find CDVViewController.m or the main AppDelegate/ViewController to
    // enable WKWebView.isInspectable (iOS 16.4+).
    // cordova-ios 7.x reads the InspectableWebview preference from config.xml
    // automatically, but we also patch the Swift/ObjC source as a fallback
    // to ensure it works on debug builds.

    const appDelegatePath = findFile(
        path.join(platformRoot, "App"), "AppDelegate.swift"
    );

    if (!appDelegatePath) {
        console.log("after_prepare hook: AppDelegate.swift not found – skipping iOS inspectable patch");
        return;
    }

    let src = fs.readFileSync(appDelegatePath, "utf8");

    // Guard against patching twice
    if (src.includes("isInspectable")) return;

    // Add WKWebView isInspectable = true after the webView is configured.
    // In cordova-ios 7.x, the CDVWebViewEngine creates the WKWebView.
    // We inject code in didFinishLaunchingWithOptions to set inspectable after
    // the web view is created by calling into the viewController.
    const inspectablePatch = `
        // Enable remote debugging (iOS 16.4+)
        if #available(iOS 16.4, *) {
            if let vc = self.window?.rootViewController,
               let webView = vc.view?.subviews.compactMap({ $0 as? WKWebView }).first {
                webView.isInspectable = true
            }
        }`;

    // Try to insert after "return true" in didFinishLaunchingWithOptions
    if (src.includes("return true")) {
        src = src.replace(
            /(\s*return true\s*\n\s*\})/,
            inspectablePatch + "\n$1"
        );

        // Add WKWebView import if missing
        if (!src.includes("import WebKit")) {
            src = src.replace(
                /(import UIKit)/,
                "$1\nimport WebKit"
            );
        }

        fs.writeFileSync(appDelegatePath, src, "utf8");
        console.log("after_prepare hook: patched AppDelegate.swift with WKWebView.isInspectable = true");
    } else {
        console.log("after_prepare hook: could not locate insertion point in AppDelegate.swift");
    }
}

/**
 * Remove any stale Java SpriteShareActivity.java left behind in the Android
 * platform directory by earlier versions of this hook. The real Kotlin
 * SpriteShareActivity is copied in by the cordova-plugin-sprite-share plugin;
 * if a leftover .java file of the same class is still present, the Kotlin and
 * Java compilers will both emit com.easierbycode.spriteshare.SpriteShareActivity
 * and Gradle will fail with a duplicate-class error — or, worse, the stub .java
 * (which just forwards to the main game without showing the sprite picker) can
 * end up in the APK and shadow the real picker activity.
 */
function removeStaleSpriteShareJavaStub(context) {
    const platformRoot = path.join(
        context.opts.projectRoot, "platforms", "android"
    );
    if (!fs.existsSync(platformRoot)) return;

    const stalePath = path.join(
        platformRoot, "app", "src", "main", "java",
        "com", "easierbycode", "spriteshare", "SpriteShareActivity.java"
    );
    if (fs.existsSync(stalePath)) {
        try {
            fs.unlinkSync(stalePath);
            console.log("after_prepare hook: removed stale SpriteShareActivity.java stub at " + stalePath);
        } catch (e) {
            console.warn("after_prepare hook: failed to remove stale SpriteShareActivity.java", e);
        }
    }
}

/**
 * Strip any android:name="...ForgeApplication" left on <application> by
 * older builds. Registering a custom Application class via the manifest
 * caused the game APK to fail to launch at all on real devices, so we now
 * intentionally leave <application> with no android:name. Idempotent.
 */
function removeStaleForgeApplicationRef(platformRoot) {
    const manifestPath = path.join(
        platformRoot, "app", "src", "main", "AndroidManifest.xml"
    );
    if (!fs.existsSync(manifestPath)) return;

    const xml = fs.readFileSync(manifestPath, "utf8");
    const stripped = xml.replace(
        /\s*android:name\s*=\s*"com\.easierbycode\.apkforge\.ForgeApplication"/g,
        ""
    );
    if (stripped !== xml) {
        fs.writeFileSync(manifestPath, stripped, "utf8");
        console.log("after_prepare hook: stripped stale ForgeApplication android:name from <application>");
    }
}

module.exports = function (context) {
    // ── iOS: enable WKWebView remote inspection ─────────────────────
    patchIOSWebViewInspectable(context);

    // ── Android: remove any stale Java SpriteShareActivity stub ─────
    // (the real Kotlin activity is installed by cordova-plugin-sprite-share)
    removeStaleSpriteShareJavaStub(context);

    const platformRoot = path.join(
        context.opts.projectRoot, "platforms", "android"
    );
    if (!fs.existsSync(platformRoot)) return;

    // ── Android: scrub stale ForgeApplication manifest reference ────
    removeStaleForgeApplicationRef(platformRoot);
};

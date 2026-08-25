#!/usr/bin/env node

/**
 * Cordova after_platform_add / after_prepare hook — iOS only.
 *
 * Adds a "SpriteShareExtension" app-extension target to the Xcode
 * project so the app appears in the iOS share sheet for images.
 *
 * What it does:
 *  1. Creates the SpriteShareExtension/ directory alongside the .xcodeproj
 *  2. Copies Swift source, Info.plist, entitlements, and web assets into it
 *  3. Copies atlas assets (JSON + PNG) so the extension can repack atlases
 *  4. Modifies project.pbxproj to add the extension target, build phases,
 *     frameworks, and build settings
 *  5. Adds App Group entitlements to both the main app and the extension
 */

const fs   = require("fs");
const path = require("path");

module.exports = function (context) {
    const projectRoot = context.opts.projectRoot;
    const platformRoot = path.join(projectRoot, "platforms", "ios");

    if (!fs.existsSync(platformRoot)) return;

    // ── Resolve app name from config.xml ──

    const appName = getAppName(projectRoot);
    const projPath = path.join(platformRoot, appName + ".xcodeproj", "project.pbxproj");

    if (!fs.existsSync(projPath)) {
        console.log("sprite-share hook: project.pbxproj not found, skipping");
        return;
    }

    // ── Load xcode module (bundled with cordova-ios) ──

    let xcode;
    try {
        xcode = context.requireCordovaModule("xcode");
    } catch (_) {
        try {
            xcode = require("xcode");
        } catch (_2) {
            console.warn("sprite-share hook: xcode module not available, skipping");
            return;
        }
    }

    const proj = xcode.project(projPath);
    proj.parseSync();

    // Guard: don't add twice
    const existingTargets = proj.pbxNativeTargetSection();
    for (const key in existingTargets) {
        if (existingTargets[key].name === "SpriteShareExtension") {
            console.log("sprite-share hook: SpriteShareExtension target already exists, skipping");
            return;
        }
    }

    const pluginDir = path.join(projectRoot,
        "plugins", "cordova-plugin-sprite-share");
    const extName = "SpriteShareExtension";
    const extDir = path.join(platformRoot, extName);
    const bundleId = "com.easierbycode.game2028.sprite-share";
    const appGroupId = "group.com.easierbycode.game2028";

    // ── 1. Create extension directory and copy files ──

    fs.mkdirSync(extDir, { recursive: true });

    // Swift source
    copyFile(
        path.join(pluginDir, "src", "ios", "ShareViewController.swift"),
        path.join(extDir, "ShareViewController.swift")
    );

    // Info.plist
    copyFile(
        path.join(pluginDir, "src", "ios", "ShareExtension-Info.plist"),
        path.join(extDir, "Info.plist")
    );

    // Web assets (sprite picker UI)
    const webFiles = [
        "sprite-picker.html",
        "sprite-picker.css",
        "sprite-picker-app.js",
        "sprite-detect.js",
    ];
    for (const f of webFiles) {
        copyFile(
            path.join(pluginDir, "www", f),
            path.join(extDir, f)
        );
    }

    // Atlas assets — copy from www/assets/ so the extension can read them
    const atlasNames = ["game_asset", "game_ui", "title_ui"];
    const wwwAssets = path.join(platformRoot, appName, "www", "assets");
    const extAssetsDir = path.join(extDir, "assets");
    const extAssetsImgDir = path.join(extAssetsDir, "img");
    fs.mkdirSync(extAssetsImgDir, { recursive: true });

    for (const name of atlasNames) {
        const jsonSrc = path.join(wwwAssets, name + ".json");
        const pngSrc = path.join(wwwAssets, "img", name + ".png");
        if (fs.existsSync(jsonSrc)) {
            copyFile(jsonSrc, path.join(extAssetsDir, name + ".json"));
        }
        if (fs.existsSync(pngSrc)) {
            copyFile(pngSrc, path.join(extAssetsImgDir, name + ".png"));
        }
    }

    // Entitlements for the extension
    const extEntitlements = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.application-groups</key>
    <array>
        <string>${appGroupId}</string>
    </array>
</dict>
</plist>`;
    fs.writeFileSync(path.join(extDir, extName + ".entitlements"), extEntitlements);

    // Entitlements for the main app (so it can read from the App Group)
    const mainEntPath = path.join(platformRoot, appName, "Entitlements-Release.plist");
    const mainEntDebugPath = path.join(platformRoot, appName, "Entitlements-Debug.plist");
    ensureAppGroupEntitlement(mainEntPath, appGroupId);
    ensureAppGroupEntitlement(mainEntDebugPath, appGroupId);

    // ── 2. Add extension target to Xcode project ──

    const target = proj.addTarget(extName, "app_extension", extName, bundleId);
    const targetUuid = target.uuid;

    // ── 3. Add source files to the target ──

    // Create a PBX group for the extension
    const groupKey = proj.pbxCreateGroup(extName, extName);

    // Add Swift source
    proj.addSourceFile(
        "ShareViewController.swift",
        { target: targetUuid },
        groupKey
    );

    // Add resources (web files + atlas assets)
    const resourceFiles = [
        ...webFiles,
        "Info.plist",
    ];
    for (const f of resourceFiles) {
        if (f === "Info.plist") continue; // Info.plist is set via build settings, not as a resource
        proj.addResourceFile(
            f,
            { target: targetUuid },
            groupKey
        );
    }

    // Add atlas asset directories as folder references
    proj.addResourceFile(
        "assets",
        { target: targetUuid },
        groupKey
    );

    // ── 4. Add frameworks ──

    proj.addFramework("WebKit.framework", { target: targetUuid });
    proj.addFramework("UniformTypeIdentifiers.framework", { target: targetUuid });

    // ── 5. Set build settings ──

    const configs = proj.pbxXCBuildConfigurationSection();
    for (const key in configs) {
        const cfg = configs[key];
        if (!cfg.buildSettings) continue;

        // Find configs belonging to our target
        if (cfg.buildSettings.PRODUCT_BUNDLE_IDENTIFIER === bundleId ||
            cfg.buildSettings.INFOPLIST_FILE === extName + "/Info.plist") {

            cfg.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = "14.0";
            cfg.buildSettings.SWIFT_VERSION = "5.0";
            cfg.buildSettings.CODE_SIGN_ENTITLEMENTS =
                '"' + extName + "/" + extName + '.entitlements"';
            cfg.buildSettings.PRODUCT_BUNDLE_IDENTIFIER = bundleId;
            cfg.buildSettings.INFOPLIST_FILE = extName + "/Info.plist";
            cfg.buildSettings.TARGETED_DEVICE_FAMILY = '"1,2"';
            cfg.buildSettings.SKIP_INSTALL = "YES";
            cfg.buildSettings.PRODUCT_NAME = '"$(TARGET_NAME)"';
            cfg.buildSettings.GENERATE_INFOPLIST_FILE = "NO";
        }
    }

    // ── 6. Add extension to main app's embed phase ──

    // Create "Embed App Extensions" copy-files build phase on main target
    const mainTargetUuid = getMainTargetUuid(proj);
    if (mainTargetUuid) {
        proj.addBuildPhase(
            [extName + ".appex"],
            "PBXCopyFilesBuildPhase",
            "Embed App Extensions",
            mainTargetUuid,
            "app_extension"
        );
    }

    // ── 7. Write the project ──

    fs.writeFileSync(projPath, proj.writeSync());
    console.log("sprite-share hook: added SpriteShareExtension target to Xcode project");
};


// ── Helpers ──

function copyFile(src, dst) {
    try {
        fs.copyFileSync(src, dst);
    } catch (e) {
        console.warn("sprite-share hook: could not copy " + src + ": " + e.message);
    }
}

function getAppName(projectRoot) {
    const configPath = path.join(projectRoot, "config.xml");
    try {
        const xml = fs.readFileSync(configPath, "utf8");
        const match = xml.match(/<name>([^<]+)<\/name>/);
        return match ? match[1] : "App";
    } catch (_) {
        return "App";
    }
}

function getMainTargetUuid(proj) {
    const targets = proj.pbxNativeTargetSection();
    for (const key in targets) {
        const t = targets[key];
        if (typeof t === "string") continue; // skip comments
        if (t.productType === '"com.apple.product-type.application"') {
            return key;
        }
    }
    return null;
}

function ensureAppGroupEntitlement(plistPath, groupId) {
    if (!fs.existsSync(plistPath)) {
        // Create a new entitlements file
        const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.application-groups</key>
    <array>
        <string>${groupId}</string>
    </array>
</dict>
</plist>`;
        fs.writeFileSync(plistPath, content);
        return;
    }

    let content = fs.readFileSync(plistPath, "utf8");
    if (content.includes("com.apple.security.application-groups")) return;

    // Insert before closing </dict>
    content = content.replace(
        /<\/dict>\s*<\/plist>/,
        `    <key>com.apple.security.application-groups</key>
    <array>
        <string>${groupId}</string>
    </array>
</dict>
</plist>`
    );
    fs.writeFileSync(plistPath, content);
}

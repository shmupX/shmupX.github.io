# --- Aloud release keep rules ---
# The following is shipped with the existing app; rule out anything the
# shrinker cannot infer.

# R8 and kotlinx.coroutines: coroutine machinery used across our own code.
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod

# --- Ktor server (D1: keep Ktor, timeboxed; fallback is a raw ServerSocket) ---
# ktor-server-core loads io.ktor.server.config.ConfigLoader through a
# ServiceLoader; R8 would otherwise strip the service files.
-keepnames class io.ktor.server.config.ConfigLoader
-keep class * implements io.ktor.server.config.ConfigLoader
-keep class io.ktor.server.cio.* { *; }
-keep class io.ktor.server.cio.internal.* { *; }
-keep class io.ktor.server.engine.* { *; }
-dontwarn org.slf4j.**
-dontwarn io.netty.**
# Ktor references JVM-only debug helpers that Android does not ship.
-dontwarn java.lang.management.**

# --- Media3 ---
# Media3 has no reflection at runtime, but its session classes are referenced
# from the manifest; keep the entries the manifest/services bind to.
-keep class androidx.media3.session.MediaSessionService { *; }
-keep class androidx.media3.session.MediaButtonReceiver { *; }

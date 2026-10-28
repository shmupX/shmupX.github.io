import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// The desktop remote's pairing defaults. Both are optional: the database has a
// working default and the code can be typed on the watch instead. Read from
// local.properties first so a personal code never has to go near the repo.
val localProps = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use(::load)
}
fun remoteProp(name: String, fallback: String = ""): String =
    (localProps.getProperty(name) ?: project.findProperty(name) as? String)
        ?.trim()?.takeIf { it.isNotEmpty() } ?: fallback
fun quoted(value: String): String = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

android {
    namespace = "com.emre.aloud"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.emre.aloud"
        minSdk = 30
        targetSdk = 37
        versionCode = 2
        versionName = "0.1.2"

        buildConfigField(
            "String",
            "REMOTE_RTDB_URL",
            quoted(remoteProp("ALOUD_RTDB_URL", "https://evil-invaders-default-rtdb.firebaseio.com")),
        )
        buildConfigField("String", "REMOTE_PAIR_CODE", quoted(remoteProp("ALOUD_PAIR_CODE")))
    }

    buildFeatures {
        compose = true
        // R26 gates the debug intent extras behind BuildConfig.DEBUG.
        buildConfig = true
    }

    signingConfigs {
        create("release") {
            // The keystore lives in ~/.gradle, never in the repo; its password
            // comes from ~/.gradle/gradle.properties (aloudReleaseStorePassword).
            storeFile = file(System.getProperty("user.home") + "/.gradle/aloud-release.jks")
            storePassword = (project.findProperty("aloudReleaseStorePassword") as? String).orEmpty()
            keyAlias = "aloud"
            keyPassword = (project.findProperty("aloudReleaseStorePassword") as? String).orEmpty()
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = signingConfigs.getByName("release")
        }
    }

    // Keep dead natives and licence spam out of a watch APK.
    packaging {
        resources {
            excludes += setOf(
                "META-INF/LICENSE*",
                "META-INF/NOTICE*",
                "META-INF/AL2.0",
                "META-INF/LGPL2.1",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        // Mp4ChapterParser logs through android.util.Log; JVM unit tests get
        // stubs rather than "not mocked" exceptions.
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.annotation.experimental)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.wear.compose.material3)
    implementation(libs.wear.compose.foundation)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.session)
    implementation(libs.datastore.preferences)
    // Ktor drags in org.fusesource.jansi for its console colours - Windows
    // DLLs and macOS dylibs shipped inside a watch APK. None of it is used.
    implementation(libs.ktor.server.core) {
        exclude(group = "org.fusesource.jansi")
    }
    implementation(libs.ktor.server.cio)
    testImplementation(libs.junit)
    // android.jar's org.json is a stub that returns defaults under unit tests;
    // the remote's wire format is parsed with it, so tests need the real one.
    testImplementation(libs.json)
    testImplementation(libs.ktor.server.test.host)
}

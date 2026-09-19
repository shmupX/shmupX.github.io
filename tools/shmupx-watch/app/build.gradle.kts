import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Bridge settings come from local.properties so nothing secret lands in git.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun local(key: String, fallback: String = "") = (localProps.getProperty(key) ?: fallback).trim()

android {
    namespace = "games.codemonkey.shmupxwatch"
    compileSdk = 36

    defaultConfig {
        applicationId = "games.codemonkey.shmupxwatch"
        // API 33 = Wear OS 4. Drop to 30 only if you need Wear OS 3 devices.
        minSdk = 33
        // 36 matters: on Wear OS 6+, apps targeting 36 are always-on by default.
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"

        buildConfigField("String", "RTDB_URL", "\"${local("SHMUPX_RTDB_URL")}\"")
        buildConfigField("String", "RTDB_AUTH", "\"${local("SHMUPX_RTDB_AUTH")}\"")
        buildConfigField("String", "BUILDER_CODE", "\"${local("SHMUPX_BUILDER_CODE")}\"")

        // Where the games catalog is served from. A native app has no "same
        // origin" to fall back to, so unlike the web launcher this is absolute
        // and always set — pointing it at a `deno task dev` machine on the LAN
        // is the only reason to change it.
        buildConfigField(
            "String",
            "CATALOG_ORIGIN",
            "\"${local("SHMUPX_CATALOG_ORIGIN", "https://codemonkey.games")}\"",
        )
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(libs.kotlinx.coroutines.android)

    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)

    implementation(libs.androidx.wear.compose.material3)
    implementation(libs.androidx.wear.compose.foundation)
    implementation(libs.androidx.wear.compose.navigation)
    implementation(libs.androidx.wear)
    implementation(libs.androidx.wear.ongoing)

    implementation(libs.okhttp)
    implementation(libs.okhttp.sse)
    implementation(libs.kotlinx.serialization.json)

    debugImplementation(composeBom)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.wear.compose.ui.tooling)
}

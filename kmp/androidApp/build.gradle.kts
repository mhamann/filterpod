plugins {
    id("com.android.application")
    kotlin("android")
    id("org.jetbrains.kotlin.plugin.compose")
    kotlin("plugin.serialization")
}

android {
    namespace = "app.filterpod"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.filterpod"
        minSdk = 26
        targetSdk = 36
        // Succeeds the Capacitor app's versionCode 3; the cutover is an upgrade.
        versionCode = 4
        versionName = "1.0.0"

        ndk {
            // arm64 only, matching the Capacitor app: building whisper.cpp four
            // times over is not worth the wait.
            abiFilters += "arm64-v8a"
        }
        externalNativeBuild {
            cmake {
                // Always optimize the native build, even in a debug APK. Gradle
                // otherwise passes CMAKE_BUILD_TYPE=Debug, compiling ggml's inner
                // loops at -O0 — measured on this device at ~0.27x realtime against
                // ~10x optimized, which starves the frontier and holds playback.
                // The Kotlin side stays debuggable; only the math is optimized.
                arguments += listOf("-DCMAKE_BUILD_TYPE=Release")
                cppFlags += "-O3"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
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
    }
}

dependencies {
    implementation(project(":shared"))

    val composeBom = platform("androidx.compose:compose-bom:2025.06.01")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.1")

    implementation("io.coil-kt.coil3:coil-compose:3.2.0")
    implementation("io.coil-kt.coil3:coil-network-okhttp:3.2.0")

    // The playback/filter core, moved from the Capacitor app.
    implementation("androidx.media3:media3-exoplayer:1.8.0")
    implementation("androidx.media3:media3-session:1.8.0")
    implementation("androidx.media3:media3-datasource:1.8.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
}

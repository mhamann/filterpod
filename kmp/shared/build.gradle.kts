plugins {
    kotlin("multiplatform")
    kotlin("plugin.serialization")
    id("com.android.library")
    id("app.cash.sqldelight")
}

kotlin {
    androidTarget()
    // iOS targets slot in here when the day comes; commonMain is written for it.

    sourceSets {
        commonMain.dependencies {
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
            implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
            implementation("app.cash.sqldelight:coroutines-extensions:2.1.0")
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
        }
        androidMain.dependencies {
            implementation("app.cash.sqldelight:android-driver:2.1.0")
        }
        // JVM-driver-backed tests run on the host, so the data layer is testable
        // without a device.
        val androidUnitTest by getting {
            dependencies {
                implementation("app.cash.sqldelight:sqlite-driver:2.1.0")
            }
        }
    }
}

android {
    namespace = "app.filterpod.shared"
    compileSdk = 36
    defaultConfig {
        minSdk = 24
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

sqldelight {
    databases {
        create("FilterPodDb") {
            packageName.set("app.filterpod.shared.db")
        }
    }
}

// Version pins for the whole build live here; modules apply what they need.
plugins {
    id("com.android.application") version "8.13.0" apply false
    id("com.android.library") version "8.13.0" apply false
    kotlin("multiplatform") version "2.2.20" apply false
    kotlin("android") version "2.2.20" apply false
    kotlin("plugin.serialization") version "2.2.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.20" apply false
    id("app.cash.sqldelight") version "2.1.0" apply false
}

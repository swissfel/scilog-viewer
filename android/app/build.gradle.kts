// The SciLog viewer on Android: the same Python server as on a computer
// (scilog_viewer/, run by Chaquopy inside the app, on 127.0.0.1 only) and its
// page in a WebView.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")
}

android {
    namespace = "ch.psi.scilogviewer"
    compileSdk = 35

    defaultConfig {
        applicationId = "ch.psi.scilogviewer"
        minSdk = 26
        targetSdk = 35
        // every CI build counts up, so a phone takes it as an update of the one before
        versionCode = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1
        versionName = System.getenv("GITHUB_REF_NAME")?.takeIf { it.startsWith("v") }?.removePrefix("v") ?: "0.2.6"
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
    }

    signingConfigs {
        // CI signs with a fixed key (repository secrets), so that updates install over older versions
        create("release") {
            val ks = System.getenv("SCILOG_KEYSTORE")
            if (ks != null && file(ks).exists()) {
                storeFile = file(ks)
                storePassword = System.getenv("SCILOG_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SCILOG_KEY_ALIAS") ?: "scilog-viewer"
                keyPassword = System.getenv("SCILOG_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (System.getenv("SCILOG_KEYSTORE") != null) signingConfigs.getByName("release")
                            else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

// the viewer's Python package, as it is in this repository
val viewerPython = layout.buildDirectory.dir("viewer-python")
val copyViewer by tasks.registering(Copy::class) {
    from(rootProject.file("../scilog_viewer")) {
        exclude("__pycache__", "**/__pycache__")
    }
    into(viewerPython.map { it.dir("scilog_viewer") })
}
tasks.named("preBuild") { dependsOn(copyViewer) }
// Chaquopy's own tasks do not run after preBuild, so they need the copy declared themselves.
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("PythonSources") }
    .configureEach { dependsOn(copyViewer) }

chaquopy {
    defaultConfig {
        version = "3.12"
        pip {
            install("tornado")
            install("requests")
            install("bleach[css]")  // cleans the posts' HTML (nh3 has no Android build)
        }
    }
    sourceSets {
        getByName("main") {
            srcDir("build/viewer-python")
        }
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}

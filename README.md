# Unsealed SDK

Prebuilt Android SDK jars with hidden framework APIs and internal resources merged back into `android.jar`.

These jars are useful when an Android app needs to compile against framework symbols that are not exposed by the official SDK, such as `@hide` APIs or `com.android.internal` resources.

## Usage

### Replace `android.jar` manually

1. Pick the jar matching your `compileSdk`: `sdks/android-37.jar` for 37.0, `sdks/android-37.1.jar` for 37.1.
2. Back up the official SDK jar. Platform directories are named `android-<major>` up to API 36 and `android-<major>.<minor>` from API 37 on:

   ```text
   $ANDROID_SDK/platforms/android-37.0/android.jar
   ```

3. Replace it with the matching jar from this repository.

### Use the Gradle helper

1. Put `unseal.gradle` in your root project and add `apply from: 'unseal.gradle'` to the root `build.gradle`.
2. Run the `unseal` task to install the unsealed jar.
3. Run the `restore` task when you want to put the official SDK jar back.

The helper reads `compileSdk` (and `compileSdkMinor` when present) from your `:app` module's android config, so there is no version to set in the script.

![Run `unseal` and `restore` from the Android Studio gutter](./art/run-from-gutter.png)

## Notes

- These jars are intended for compile-time and IDE usage. They do not bypass Android runtime hidden API enforcement.
- Always keep a backup of the official SDK jar so the platform can be restored cleanly.
- Only replace the SDK platform matching your project's `compileSdk`.
- Jars for API 37 and later (including minor releases such as 37.1) are built by the current pipeline; jars for API 36 and earlier are legacy builds kept as-is.

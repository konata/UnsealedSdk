# Unsealed SDK

Prebuilt Android SDK jars with hidden framework APIs and internal resources merged back into `android.jar`.

These jars are useful when an Android app needs to compile against framework symbols that are not exposed by the official SDK, such as `@hide` APIs or `com.android.internal` resources.

## Usage

### Replace `android.jar` manually

1. Pick the jar matching your `compileSdk`, for example `sdks/android-37.jar`.
2. Back up the official SDK jar:

   ```text
   $ANDROID_SDK/platforms/android-37/android.jar
   ```

3. Replace it with the matching jar from this repository.

### Use the Gradle helper

1. Copy the contents of `unseal-hidden.gradle` into your app module's `build.gradle`.
2. Set `designatedCompileSdkVersion` to your `compileSdk` version.
3. Run the `unseal` task to install the unsealed jar.
4. Run the `restore` task when you want to put the official SDK jar back.

![Run `unseal` and `restore` from the Android Studio gutter](./art/run-from-gutter.png)

## Notes

- These jars are intended for compile-time and IDE usage. They do not bypass Android runtime hidden API enforcement.
- Always keep a backup of the official SDK jar so the platform can be restored cleanly.
- Only replace the SDK platform matching your project's `compileSdk`.

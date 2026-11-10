# Unsealed SDK

Prebuilt Android SDK jars with hidden framework APIs and internal resources merged back into `android.jar`.

These jars are useful when an Android app needs to compile against framework symbols that are not exposed by the official SDK, such as `@hide` APIs or `com.android.internal` resources.

## Usage

### Use the Bun CLI

1. Run `bun ls` to list the installed SDK platforms and their states.
2. Run `bun unseal 37.0` to install the unsealed jar (downloads it on the first run).
3. Run `bun restore 37.0` when you want to put the official SDK jar back.
4. Run `bun purge 37.0` to also delete the unsealed jar and the official backup.
5. Run `bun man` for the full command reference.

The SDK is located through `ANDROID_HOME` (with `ANDROID_SDK_ROOT` as fallback).

## Notes

- These jars are intended for compile-time and IDE usage. They do not bypass Android runtime hidden API enforcement.
- Always keep a backup of the official SDK jar so the platform can be restored cleanly.
- Only replace the SDK platform matching your project's `compileSdk`.
- Jars for API 37 and later (including minor releases such as 37.1) are built by the current pipeline; jars for API 36 and earlier are legacy builds kept as-is.
- The `res/*.png` payloads are not included in the current pipeline's jars: linking only reads `resources.arsc` and resolves resource files on the device, so the PNG bytes are never used.

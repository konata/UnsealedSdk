# android-hidden-api-integration

android.jar[s] with @hide annotation stripped and internal resources | classes merged

# to ulitize android hidden api / resources,

### You may

1. manually replace `$ANDROID_SDK/platforms/$version/android.jar` with files `sdks/android-${version}.jar`

### Or just

1. paste `unseal-hidden.gradle` contents into your project's `build.gradle`
2. change `designatedCompileSdkVersion` to your compileSdkVersion
3. run task `unseal` and `restore` from android studio gutter like below

![run `unseal` and `restore` from gutter](./art/run-from-gutter.png)

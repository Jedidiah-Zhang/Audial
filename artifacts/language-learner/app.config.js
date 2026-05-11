// Dynamic Expo config. Overrides values from `app.json` at build time so
// EAS profiles (development / preview / production) can inject the real
// AdMob app IDs from env vars without editing `app.json`.
//
// `app.json` keeps Google's official **test** AdMob app IDs as defaults,
// which display real ads in dev builds but never earn revenue. To ship a
// production build that serves real revenue ads, set these env vars in
// the matching EAS build profile (or local `.env`):
//
//   EXPO_PUBLIC_ADMOB_ANDROID_APP_ID=ca-app-pub-XXXXXXXXXXXXXXXX~XXXXXXXXXX
//   EXPO_PUBLIC_ADMOB_IOS_APP_ID=ca-app-pub-XXXXXXXXXXXXXXXX~XXXXXXXXXX
//
// Per-placement rewarded ad unit IDs are read at runtime from
// EXPO_PUBLIC_ADMOB_REWARDED_<PLACEMENT>_ID_(IOS|ANDROID) — see
// `hooks/useRewardedAd.ts` for the full list.

const { withGradleProperties } = require("@expo/config-plugins");

const TEST_ANDROID_APP_ID = "ca-app-pub-3940256099942544~3347511713";
const TEST_IOS_APP_ID = "ca-app-pub-3940256099942544~1458002511";

/**
 * Fixes duplicate META-INF file from jspecify and okhttp logging-interceptor.
 * The generated android/app/build.gradle already reads
 * `android.packagingOptions.excludes` from gradle.properties — we just need
 * to set the value so the duplicate is excluded at mergeReleaseJavaResource.
 */
const withAndroidPackagingExcludes = (config) => {
  return withGradleProperties(config, (config) => {
    const key = "android.packagingOptions.excludes";
    if (config.modResults.some((p) => p.type === "property" && p.key === key && p.value.includes("META-INF/versions/9/OSGI-INF"))) {
      return config;
    }
    config.modResults.push({
      type: "property",
      key,
      value: "META-INF/versions/9/OSGI-INF/MANIFEST.MF",
    });
    return config;
  });
};

module.exports = ({ config }) => {
  const androidAppId =
    process.env.EXPO_PUBLIC_ADMOB_ANDROID_APP_ID || TEST_ANDROID_APP_ID;
  const iosAppId =
    process.env.EXPO_PUBLIC_ADMOB_IOS_APP_ID || TEST_IOS_APP_ID;

  const basePlugins = Array.isArray(config.plugins) ? config.plugins : [];
  const pluginsWithoutAdMob = basePlugins.filter(
    (p) => !(Array.isArray(p) && p[0] === "react-native-google-mobile-ads"),
  );
  const adMobOriginal = basePlugins.find(
    (p) => Array.isArray(p) && p[0] === "react-native-google-mobile-ads",
  );
  const adMobOptions =
    adMobOriginal && Array.isArray(adMobOriginal) && adMobOriginal[1]
      ? adMobOriginal[1]
      : {};

  return {
    ...config,
    plugins: [
      withAndroidPackagingExcludes,
      ...pluginsWithoutAdMob,
      [
        "react-native-google-mobile-ads",
        {
          ...adMobOptions,
          androidAppId,
          iosAppId,
        },
      ],
    ],
  };
};

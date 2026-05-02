# AdMob (Google Mobile Ads) Setup

The rewarded-video flows in this app are powered by
[`react-native-google-mobile-ads`](https://github.com/invertase/react-native-google-mobile-ads).
Because the SDK relies on a native module, **real ads cannot run inside Expo
Go**. Use it only in:

- An Expo development build (`expo prebuild` + `eas build --profile development`)
- An EAS production / preview build

In Expo Go and on the web preview, the app falls back to the `RewardedAdSimulatorHost`
modal so the UX flow remains testable.

## Build-time env vars (read by `app.config.js`)

These set the AdMob app IDs that get baked into the native build manifest:

| Var                                | Default (test)                          |
| ---------------------------------- | --------------------------------------- |
| `EXPO_PUBLIC_ADMOB_ANDROID_APP_ID` | `ca-app-pub-3940256099942544~3347511713` |
| `EXPO_PUBLIC_ADMOB_IOS_APP_ID`     | `ca-app-pub-3940256099942544~1458002511` |

The defaults are Google's official **test** app IDs — they show real ads but
never earn revenue. Set the env vars in your EAS production profile (e.g.
`eas.json` → `build.production.env`) to your own AdMob app IDs before shipping.

## Runtime env vars (read by `hooks/useRewardedAd.ts`)

The same platform-specific app ID env vars also flip the runtime SDK on. **If
neither is set in the build, the app will silently keep using the simulator
even on a native build** — make sure your production EAS profile sets at least
one of them.

Optional per-placement ad unit ID overrides (default to Google's public test
rewarded unit IDs when unset):

| Placement          | iOS env var                                          | Android env var                                          |
| ------------------ | ---------------------------------------------------- | -------------------------------------------------------- |
| `generation`       | `EXPO_PUBLIC_ADMOB_REWARDED_GENERATION_ID_IOS`       | `EXPO_PUBLIC_ADMOB_REWARDED_GENERATION_ID_ANDROID`       |
| `analysis_unlock`  | `EXPO_PUBLIC_ADMOB_REWARDED_ANALYSIS_ID_IOS`         | `EXPO_PUBLIC_ADMOB_REWARDED_ANALYSIS_ID_ANDROID`         |
| `dictation_replay` | `EXPO_PUBLIC_ADMOB_REWARDED_DICTATION_ID_IOS`        | `EXPO_PUBLIC_ADMOB_REWARDED_DICTATION_ID_ANDROID`        |

## Pre-publish checklist

1. Replace the test app IDs in your production EAS profile with real ones from
   your AdMob console.
2. Replace the per-placement ad unit IDs with real rewarded IDs from your AdMob
   console.
3. Add a UMP (User Messaging Platform) consent flow before the first ad load
   in regulated regions, and an iOS App Tracking Transparency prompt before
   enabling personalized ads. The hook currently forces
   `requestNonPersonalizedAdsOnly: true` as a stopgap — see the open follow-up
   tasks.

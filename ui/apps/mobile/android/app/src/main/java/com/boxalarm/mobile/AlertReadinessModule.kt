package com.boxalarm.mobile

import android.app.Activity
import android.app.KeyguardManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * The device side of "loud" that notifee cannot reach (src/features/alerts/alertReadiness.ts):
 *
 * - Do Not Disturb policy access. `setBypassDnd(true)` on a channel is honoured only when the app
 *   holds notification-policy access at the moment the channel is created, and channels are
 *   immutable afterwards - so JS checks this, walks the member to the grant, then recreates the
 *   critical channel under a new id.
 * - Full-screen intent. Since Android 14, USE_FULL_SCREEN_INTENT is not auto-granted to apps
 *   that are not calling/alarm apps; without it a page degrades to a heads-up that times out.
 * - The critical channel itself, created here because notifee channels can only use a bundled
 *   res/raw sound or "default". No fire-tone asset exists in this repo, so the channel uses the
 *   system ALARM sound with USAGE_ALARM audio attributes (plays on the alarm stream, at alarm
 *   volume) and the notification loops it (FLAG_INSISTENT via notifee `loopSound`).
 * - Show-over-lock-screen, scoped to the alert screen (see MainActivity).
 *
 * Every method needs device verification - nothing here can run in this repo's CI.
 */
class AlertReadinessModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "BoxalarmAlertReadiness"

  private val notificationManager: NotificationManager
    get() = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  @ReactMethod
  fun getReadiness(promise: Promise) {
    try {
      val result = Arguments.createMap()
      result.putBoolean("dndAccessGranted", notificationManager.isNotificationPolicyAccessGranted)
      result.putBoolean(
        "fullScreenIntentAllowed",
        if (Build.VERSION.SDK_INT >= 34) notificationManager.canUseFullScreenIntent() else true,
      )
      result.putInt("sdkInt", Build.VERSION.SDK_INT)
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("E_READINESS", error)
    }
  }

  /** Returns the channel's live DND-bypass flag, or null when the channel does not exist. */
  @ReactMethod
  fun getChannelBypassDnd(channelId: String, promise: Promise) {
    if (Build.VERSION.SDK_INT < 26) {
      promise.resolve(null)
      return
    }
    val channel = notificationManager.getNotificationChannel(channelId)
    promise.resolve(channel?.canBypassDnd())
  }

  @ReactMethod
  fun createCriticalChannel(channelId: String, name: String, promise: Promise) {
    // Below Android 8 there are no channels; notifee's per-notification sound/priority applies.
    if (Build.VERSION.SDK_INT < 26) {
      promise.resolve(false)
      return
    }
    try {
      val alarmSound: Uri =
        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
          ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
          ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
      val audio =
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_ALARM)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build()
      val channel =
        NotificationChannel(channelId, name, NotificationManager.IMPORTANCE_HIGH).apply {
          description = "Dispatch pages. Rings through Do Not Disturb when Boxalarm is allowed to."
          setBypassDnd(true)
          setSound(alarmSound, audio)
          enableVibration(true)
          vibrationPattern = longArrayOf(0, 800, 400, 800, 400, 800)
          enableLights(true)
          lightColor = Color.RED
          lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
        }
      notificationManager.createNotificationChannel(channel)
      promise.resolve(notificationManager.getNotificationChannel(channelId)?.canBypassDnd() ?: false)
    } catch (error: Exception) {
      promise.reject("E_CHANNEL", error)
    }
  }

  @ReactMethod
  fun deleteChannel(channelId: String, promise: Promise) {
    if (Build.VERSION.SDK_INT < 26) {
      promise.resolve(null)
      return
    }
    notificationManager.deleteNotificationChannel(channelId)
    promise.resolve(null)
  }

  @ReactMethod
  fun openDndAccessSettings(promise: Promise) {
    startSettings(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS), promise)
  }

  @ReactMethod
  fun openFullScreenIntentSettings(promise: Promise) {
    if (Build.VERSION.SDK_INT < 34) {
      promise.resolve(false)
      return
    }
    startSettings(
      Intent(
        Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
        Uri.parse("package:${reactContext.packageName}"),
      ),
      promise,
    )
  }

  /** Whether the keyguard is up - the alert screen only silences a ringing page on its own
   * when the member can actually see it (unlocked, app active). */
  @ReactMethod
  fun isKeyguardLocked(promise: Promise) {
    val keyguard = reactContext.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
    promise.resolve(keyguard.isKeyguardLocked)
  }

  /** The alert screen asks to be shown over the lock screen; everything else is not. */
  @ReactMethod
  fun setShowWhenLocked(show: Boolean) {
    val activity: Activity = reactContext.currentActivity ?: return
    UiThreadUtil.runOnUiThread {
      if (Build.VERSION.SDK_INT >= 27) {
        activity.setShowWhenLocked(show)
        activity.setTurnScreenOn(show)
      }
    }
  }

  private fun startSettings(intent: Intent, promise: Promise) {
    try {
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      reactContext.startActivity(intent)
      promise.resolve(true)
    } catch (error: Exception) {
      // Some OEM builds lack the screen; fall back to the app's own notification settings.
      try {
        val fallback =
          Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, reactContext.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        reactContext.startActivity(fallback)
        promise.resolve(false)
      } catch (inner: Exception) {
        promise.reject("E_SETTINGS", inner)
      }
    }
  }
}

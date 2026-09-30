package com.boxalarm.mobile

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "Boxalarm"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * A dispatch page's full-screen intent launches this activity while the phone is locked.
   * notifee's fullScreenAction only draws over the keyguard and wakes the screen when the
   * activity is showWhenLocked + turnScreenOn, so it is set here - but only for a launch that
   * arrives while the keyguard is up (which, for this app, is the full-screen page), so the rest
   * of the app is not exposed on a locked phone. The alert screen clears it again when the member
   * leaves it (AlertReadinessModule.setShowWhenLocked, called from JS).
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
    showOverKeyguardIfLocked()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    showOverKeyguardIfLocked()
  }

  private fun showOverKeyguardIfLocked() {
    if (Build.VERSION.SDK_INT < 27) return
    val keyguard = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
    if (keyguard.isKeyguardLocked) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    }
  }
}

package ch.psi.scilogviewer

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

/**
 * SciLog's own page and login (PSI account, MFA) inside the app. Once logged
 * in, SciLog keeps its token in the page's local storage: it is read from
 * there, handed to the viewer, and this screen closes.
 */
class LoginActivity : Activity() {
    private lateinit var web: WebView
    private val handler = Handler(Looper.getMainLooper())
    private var clearedExpired = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val note = TextView(this).apply {
            text = "Log in to SciLog. The viewer takes your token as soon as you are in (it lasts 14 days)."
            setPadding(32, 24, 32, 24)
            setBackgroundColor(Color.parseColor("#F6F7F9"))
            setTextColor(Color.parseColor("#1D1F23"))
        }
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.webViewClient = WebViewClient()
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(note, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        })
        web.loadUrl("https://scilog.psi.ch/")
        handler.postDelayed(::look, 1500)
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    @Deprecated("the WebView's history first")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    /** Once a second: is there a token, from SciLog's own page, not expired? */
    private fun look() {
        if (android.net.Uri.parse(web.url ?: "").host != "scilog.psi.ch") { handler.postDelayed(::look, 1000); return }
        web.evaluateJavascript("(function(){try{return localStorage.getItem('id_token')}catch(e){return null}})()") { raw ->
            val token = raw?.trim()?.removeSurrounding("\"") ?: ""
            when {
                token.isEmpty() || token == "null" || token.count { it == '.' } != 2 -> handler.postDelayed(::look, 1000)
                expired(token) -> {
                    // an old login in this app: let SciLog ask for a new one
                    if (!clearedExpired) {
                        clearedExpired = true
                        web.evaluateJavascript("localStorage.removeItem('id_token'); location.href='https://scilog.psi.ch/login';", null)
                    }
                    handler.postDelayed(::look, 1500)
                }
                else -> {
                    setResult(RESULT_OK, Intent().putExtra("token", token))
                    finish()
                }
            }
        }
    }

    private fun expired(token: String): Boolean = try {
        val payload = String(Base64.decode(token.split(".")[1], Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP))
        JSONObject(payload).optLong("exp", 0) * 1000 < System.currentTimeMillis() + 60_000
    } catch (e: Exception) { false }
}

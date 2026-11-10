package ch.psi.scilogviewer

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * The viewer: its Python server runs in this app's process (127.0.0.1, a free
 * port, an access key of its own) and its page is shown here. Links to other
 * sites open in the phone's browser; attachments are saved to Downloads.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    companion object {
        private const val FILE_REQUEST = 1
        private const val LOGIN_REQUEST = 2
    }

    private fun python(): Python {
        if (!Python.isStarted()) Python.start(AndroidPlatform(applicationContext))
        return Python.getInstance()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = true
        web.addJavascriptInterface(Bridge(), "ScilogAndroid")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val host = request.url.host
                if (host == "127.0.0.1" || host == "localhost") return false
                try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (e: Exception) { toast("No app opens ${request.url}") }
                return true
            }

            // the "Starting ..." page must not stay in the history: Back would end on it, white
            override fun onPageFinished(view: WebView, url: String) {
                if (url.startsWith("http://")) view.clearHistory()
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                val intent = params.createIntent().apply {
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                }
                return try { startActivityForResult(intent, FILE_REQUEST); true } catch (e: Exception) { fileCallback = null; false }
            }
        }
        web.setDownloadListener { url, _, disposition, mime, _ -> download(url, disposition, mime) }
        web.loadData("<p style='font:16px sans-serif;color:#5f6672;padding:24px'>Starting the SciLog viewer …</p>", "text/html", "utf-8")
        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        Thread {
            try {
                val url = python().getModule("android_main").callAttr("start", filesDir.absolutePath).toString()
                runOnUiThread {
                    // after Android ended the app, the restored page points at the old server (another
                    // port and key): open the new one, at the same place (the part after #)
                    val old = web.url
                    val same = old != null && Uri.parse(old).port == Uri.parse(url).port && old.startsWith("http://")
                    if (!same) {
                        val place = old?.takeIf { it.startsWith("http://") }?.let { Uri.parse(it).fragment }
                        web.loadUrl(if (place.isNullOrEmpty()) url else "${url.substringBefore('#')}#$place")
                    }
                }
            } catch (e: Exception) {
                runOnUiThread { web.loadData("<p style='font:16px sans-serif;padding:24px'>The viewer could not start: ${e.message}</p>", "text/html", "utf-8") }
            }
        }.start()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    // Back closes what the page has open on top (picture, menu, search, dialog, editor, ...), the
    // topmost first; the page opens those without history entries. With nothing left open the app
    // goes to the background, its server and place kept.
    @Deprecated("the page decides first")
    override fun onBackPressed() {
        if (web.url?.startsWith("http://") != true) { moveTaskToBack(true); return }
        web.evaluateJavascript("(window.scilogBack && window.scilogBack()) ? 1 : 0") { result ->
            if (result != "1") askToLeave()
        }
    }

    // nothing left to close: leave only when asked to (the app keeps running in the background)
    private fun askToLeave() {
        android.app.AlertDialog.Builder(this)
            .setMessage("Leave the SciLog viewer?")
            .setPositiveButton("Leave") { _, _ -> moveTaskToBack(true) }
            .setNegativeButton("Stay", null)
            .show()
    }

    @Deprecated("startActivityForResult")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            FILE_REQUEST -> {
                val picked: Array<Uri>? = if (resultCode != RESULT_OK || data == null) null else {
                    val clip = data.clipData
                    if (clip != null) Array(clip.itemCount) { clip.getItemAt(it).uri }
                    else data.data?.let { arrayOf(it) }
                }
                fileCallback?.onReceiveValue(picked)
                fileCallback = null
            }
            LOGIN_REQUEST -> {
                val token = data?.getStringExtra("token") ?: return
                Thread {
                    val err = python().getModule("android_main").callAttr("set_token", token).toString()
                    runOnUiThread {
                        if (err.isEmpty()) { toast("Logged in to SciLog"); web.reload() } else toast("Token not accepted: $err")
                    }
                }.start()
            }
        }
    }

    /** Called from the page's token window: SciLog's own login, inside the app. */
    inner class Bridge {
        @JavascriptInterface
        fun login() {
            runOnUiThread {
                @Suppress("DEPRECATION")
                startActivityForResult(Intent(this@MainActivity, LoginActivity::class.java), LOGIN_REQUEST)
            }
        }
    }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()

    /** An attachment from the viewer's server (it needs the page's cookie) into Downloads. */
    private fun download(url: String, disposition: String?, mime: String?) {
        val cookie = CookieManager.getInstance().getCookie(url)
        val name = URLUtil.guessFileName(url, disposition, mime)
        toast("Downloading $name …")
        Thread {
            try {
                val conn = URL(url).openConnection() as HttpURLConnection
                if (cookie != null) conn.setRequestProperty("Cookie", cookie)
                conn.inputStream.use { input ->
                    if (Build.VERSION.SDK_INT >= 29) {
                        val values = ContentValues().apply {
                            put(MediaStore.Downloads.DISPLAY_NAME, name)
                            put(MediaStore.Downloads.MIME_TYPE, mime ?: "application/octet-stream")
                        }
                        val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                            ?: throw IllegalStateException("no place in Downloads")
                        contentResolver.openOutputStream(uri)!!.use { input.copyTo(it) }
                    } else {
                        val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: filesDir
                        File(dir, name).outputStream().use { input.copyTo(it) }
                    }
                }
                runOnUiThread { toast("$name saved to Downloads") }
            } catch (e: Exception) {
                runOnUiThread { toast("Not downloaded: ${e.message}") }
            }
        }.start()
    }
}

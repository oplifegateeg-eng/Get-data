package com.example.wagroupsexporter

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.TypedValue
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.io.OutputStream

/**
 * WhatsApp Groups Exporter (Android).
 * WhatsApp Web runs inside the WebView (you link it like any other linked device). The export engine
 * (assets/exporter.js) runs inside that page, reads the groups, members, admins, invite links and chat
 * history that WhatsApp makes available, and hands the finished Excel file to this app, which saves it
 * in the Downloads folder.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var button: Button
    private lateinit var statusView: TextView
    private lateinit var progressView: TextView
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView

    private var exportActive = false
    private var finishedUri: Uri? = null
    private var currentUri: Uri? = null
    private var out: OutputStream? = null
    private val logLines = ArrayDeque<String>()

    private val mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

    // Settings of the export (edit here and rebuild).
    private val config = """{"getLinks":true,"refresh":true,"skipWait":false,"syncStableSec":60,"syncMaxMin":15,"delay":1500,"memberHistory":true,"historyBudgetSec":120,"historyCallSec":60,"historyMaxMessages":0,"savedOnly":false,"expected":0}"""

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            setPadding(dp(10), dp(10), dp(10), dp(10))
        }

        statusView = TextView(this).apply {
            text = "1) Link WhatsApp in the page below.  2) Tap Start."
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setTextColor(Color.BLACK)
        }
        val hint = TextView(this).apply {
            text = "To link: on the WhatsApp page choose \"Link with phone number\", enter your number, then type the code in WhatsApp > Linked devices > Link a device > Link with phone number instead."
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTextColor(Color.DKGRAY)
        }
        button = Button(this).apply {
            text = "Start"
            setOnClickListener { onButton() }
        }
        progressView = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(Color.DKGRAY)
        }
        logView = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            setTextColor(Color.DKGRAY)
        }
        logScroll = ScrollView(this).apply { addView(logView) }
        web = WebView(this)

        root.addView(statusView)
        root.addView(hint)
        root.addView(button)
        root.addView(progressView)
        root.addView(logScroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(110)))
        root.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)

        setupWebView()
        web.loadUrl("https://web.whatsapp.com/")
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val s = web.settings
        // WhatsApp Web only opens with a desktop browser identity.
        val def = s.userAgentString ?: ""
        val ver = Regex("Chrome/([0-9.]+)").find(def)?.groupValues?.get(1) ?: "124.0.0.0"
        s.userAgentString = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$ver Safari/537.36"
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.useWideViewPort = true
        s.loadWithOverviewMode = true
        s.setSupportZoom(true)
        s.builtInZoomControls = true
        s.displayZoomControls = false

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)

        web.addJavascriptInterface(Bridge(), "Android")
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                // If WhatsApp reloads itself during an export, start the engine again; it resumes from the saved progress.
                if (exportActive && url != null && url.contains("web.whatsapp.com")) injectAndStart()
            }
        }
    }

    private fun onButton() {
        val done = finishedUri
        if (done != null) {
            openFile(done)
            return
        }
        if (!exportActive) startExport()
    }

    private fun startExport() {
        exportActive = true
        finishedUri = null
        button.isEnabled = false
        button.text = "Working..."
        setStatus("Starting...")
        (web.layoutParams as LinearLayout.LayoutParams).apply {
            height = dp(160)
            weight = 0f
        }
        web.requestLayout()
        injectAndStart()
    }

    private fun injectAndStart() {
        val js = assets.open("exporter.js").bufferedReader().use { it.readText() }
        web.evaluateJavascript(js) {
            web.evaluateJavascript(
                "window.__waExporter && window.__waExporter.start(" + JSONObject.quote(config) + ")",
                null
            )
        }
    }

    private fun openFile(uri: Uri) {
        try {
            startActivity(
                Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, mime)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (e: Exception) {
            Toast.makeText(this, "Saved in your Downloads folder.", Toast.LENGTH_LONG).show()
        }
    }

    private fun setStatus(msg: String) = runOnUiThread { statusView.text = msg }

    private fun addLog(msg: String) {
        runOnUiThread {
            logLines.addLast(msg)
            while (logLines.size > 150) logLines.removeFirst()
            logView.text = logLines.joinToString("\n")
            logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
        }
    }

    private val stateFile: File get() = File(filesDir, "export-state.json")

    override fun onDestroy() {
        try { out?.close() } catch (e: Exception) { }
        web.destroy()
        super.onDestroy()
    }

    /** Functions the page (exporter.js) can call. */
    inner class Bridge {
        @JavascriptInterface fun log(msg: String) = addLog(msg)

        @JavascriptInterface fun status(msg: String) = setStatus(msg)

        @JavascriptInterface fun progress(msg: String) = runOnUiThread { progressView.text = msg }

        @JavascriptInterface fun fail(msg: String) {
            exportActive = false
            setStatus("Stopped: $msg")
            addLog("Stopped: $msg")
            runOnUiThread {
                button.isEnabled = true
                button.text = "Try again (continues where it stopped)"
            }
        }

        @JavascriptInterface fun loadState(): String =
            try { if (stateFile.exists()) stateFile.readText() else "" } catch (e: Exception) { "" }

        @JavascriptInterface fun saveState(json: String) {
            try { stateFile.writeText(json) } catch (e: Exception) { }
        }

        @JavascriptInterface fun clearState() {
            try { stateFile.delete() } catch (e: Exception) { }
        }

        @JavascriptInterface fun fileBegin(name: String) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            }
            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            currentUri = uri
            out = uri?.let { contentResolver.openOutputStream(it) }
        }

        @JavascriptInterface fun fileChunk(b64: String) {
            out?.write(Base64.decode(b64, Base64.DEFAULT))
        }

        @JavascriptInterface fun fileEnd(name: String, partial: Boolean) {
            try { out?.close() } catch (e: Exception) { }
            out = null
            exportActive = false
            finishedUri = currentUri
            val text = if (partial) "Saved a PARTIAL file in Downloads: $name" else "Finished. Saved in Downloads: $name"
            setStatus(text)
            addLog(text)
            runOnUiThread {
                button.isEnabled = true
                button.text = "Open the Excel file"
            }
        }
    }
}

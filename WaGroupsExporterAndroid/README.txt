WhatsApp Groups Exporter - Android app
======================================

What it does
  Opens WhatsApp Web inside the app (you link it as a linked device), then exports to an Excel file in your
  Downloads folder: all groups (from WhatsApp's server list), members, admins, invite links (groups where you are
  admin), last activity of each group and each member's last message in each group (as far as WhatsApp has the chats).
  Sheets: Summary, Groups, My Admin Groups, Members, Contacts, Issues.

Requirements
  Android 10 or newer. Keep the app open with the screen on and the phone charging while it runs (it can take hours).

How to get the APK file (no Android Studio needed)
  The APK has to be compiled by Android's build tools, which is done for you for free by GitHub:
     1. Create a free account on github.com, then click "New repository". Name it anything and choose Public.
     2. Unzip this folder on your PC. In the repository click "Add file" > "Upload files" and drag in EVERYTHING
        from inside the folder (app, gradle, .github, build.gradle.kts, settings.gradle.kts, gradle.properties,
        README.txt). Click "Commit changes".
        Check that the file .github/workflows/build-apk.yml exists in the repository. If it is missing, click
        "Add file" > "Create new file", type  .github/workflows/build-apk.yml  as the name, paste the contents
        of that file, and commit.
     3. Open the "Actions" tab. A run called "Build APK" starts by itself (about 5-10 minutes). If it does not
        start, open "Build APK" and click "Run workflow".
     4. When the run has a green tick, go to the repository main page > "Releases" (right side) > open the newest
        release > download  app-debug.apk  - you can do this directly in the browser on your phone.
     5. Open the downloaded file and allow "Install unknown apps" for your browser when Android asks.
  If the run shows a red cross, open it and send me the error text from the failed step.

  Alternative: with Android Studio open this folder, wait for the Gradle sync, then
  Build > Build Bundle(s) / APK(s) > Build APK(s)  (output: app/build/outputs/apk/debug/app-debug.apk).

How to use
  1. Open the app. The WhatsApp Web page loads in the lower part of the screen.
  2. Link it: on that page choose "Link with phone number", enter your number, then in WhatsApp go to
     Linked devices > Link a device > "Link with phone number instead" and type the code shown.
     (A QR code on a second device or screen also works.)
  3. When your chats are visible, tap Start. Progress and a short log are shown at the top.
  4. When it says "Finished", tap the button to open the Excel file (it is in the Downloads folder).
  If the app stops or WhatsApp reloads, tap Start again: it continues from the saved progress.

Settings
  In app/src/main/java/com/example/wagroupsexporter/MainActivity.kt, the line "private val config" holds the
  settings (waiting times, whether to load older messages, ...). Change them and build again.

Good to know
  - A newly linked device receives only part of your chat history. The group list, members, admins and links come
    from WhatsApp's server and are complete; a member's last message is only known for chats WhatsApp has on this device.
  - Using WhatsApp Web inside another app is not an official WhatsApp feature. Use it for your own account only.
  - To unlink the app later: WhatsApp > Linked devices > select the device > Log out.

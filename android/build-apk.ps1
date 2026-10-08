$ErrorActionPreference = "Stop"
$sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk"
$bt = Join-Path $sdk "build-tools\34.0.0"
$androidJar = Join-Path $sdk "platforms\android-34\android.jar"
$root = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $root "index.html"))) { $root = "C:\Users\79262\OlyaNotes" }
$proj = Join-Path $root "android"
$work = Join-Path $proj "build-manual"

if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force -Path "$work\classes", "$work\dex", "$work\assets\www" | Out-Null

Copy-Item (Join-Path $root "index.html"), (Join-Path $root "manifest.webmanifest"), (Join-Path $root "sw.js"), (Join-Path $root "icon-192.png"), (Join-Path $root "icon-512.png") "$work\assets\www\"
Copy-Item (Join-Path $root "src") "$work\assets\www\src" -Recurse

& (Join-Path $bt "aapt2.exe") compile --dir (Join-Path $proj "app\src\main\res") -o (Join-Path $work "compiled.zip")
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

& (Join-Path $bt "aapt2.exe") link `
    -I $androidJar `
    --manifest (Join-Path $proj "app\src\main\AndroidManifest.xml") `
    -A (Join-Path $work "assets") `
    -o (Join-Path $work "unsigned.apk") `
    --min-sdk-version 24 `
    --target-sdk-version 34 `
    (Join-Path $work "compiled.zip")
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

$javac = "C:\Program Files\Java\jdk-17.0.2\bin\javac.exe"
& $javac --release 8 -encoding UTF-8 -classpath $androidJar -d (Join-Path $work "classes") (Join-Path $proj "app\src\main\java\notes\olya\app\MainActivity.java")
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

& (Join-Path $bt "d8.bat") --min-api 24 --lib $androidJar --output (Join-Path $work "dex") (Join-Path $work "classes\notes\olya\app\MainActivity.class")
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

$jar = "C:\Program Files\Java\jdk-17.0.2\bin\jar.exe"
Push-Location (Join-Path $work "dex")
& $jar -uf (Join-Path $work "unsigned.apk") classes.dex
Pop-Location
if ($LASTEXITCODE -ne 0) { throw "jar failed" }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$slashApk = Join-Path $work "slash.apk"
$srcZip = [System.IO.Compression.ZipFile]::OpenRead((Join-Path $work "unsigned.apk"))
$dstZip = [System.IO.Compression.ZipFile]::Open($slashApk, "Create")
foreach ($entry in $srcZip.Entries) {
    $name = ($entry.FullName -replace "\\", "/")
    if ($name.EndsWith("/")) { continue }
    $created = $dstZip.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
    $input = $entry.Open()
    $output = $created.Open()
    $input.CopyTo($output)
    $output.Dispose()
    $input.Dispose()
}
$srcZip.Dispose()
$dstZip.Dispose()

& (Join-Path $bt "zipalign.exe") -f -p 4 $slashApk (Join-Path $work "aligned.apk")
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

$ks = Join-Path $proj "debug.keystore"
$keytool = "C:\Program Files\Java\jdk-17.0.2\bin\keytool.exe"
if (-not (Test-Path $ks)) {
    & $keytool -genkeypair -keystore $ks -storepass android -keypass android -alias olyanotes -dname "CN=OlyaNotes" -keyalg RSA -keysize 2048 -validity 10000
    if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
}

$out = Join-Path $root "OlyaNotes.apk"
& (Join-Path $bt "apksigner.bat") sign --ks $ks --ks-pass pass:android --key-pass pass:android --out $out (Join-Path $work "aligned.apk")
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }

& (Join-Path $bt "apksigner.bat") verify $out
Write-Output "APK: $out"

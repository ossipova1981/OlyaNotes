@echo off
chcp 65001 >nul
cd /d "%~dp0"
set APP=desktop\publish-standalone\OlyaNotes.exe
if not exist "%APP%" set APP=desktop\publish\OlyaNotes.exe
if not exist "%APP%" (
  echo Файл приложения не найден. Сначала соберите его в Cursor или выполните:
  echo   cd desktop\OlyaNotesDesktop
  echo   dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o ..\publish-standalone
  pause
  exit /b 1
)
start "" "%~dp0%APP%"

@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo Запускаю OlyaNotes...
echo На Asus оставьте это окно открытым — так работают веб и синхронизация.
echo На телефоне и планшете откройте адрес из этого окна и в приложении
echo нажмите «Синхронизация», введите тот же адрес и общий код.
echo.
start "" http://127.0.0.1:5173/
node server.js
if errorlevel 1 pause

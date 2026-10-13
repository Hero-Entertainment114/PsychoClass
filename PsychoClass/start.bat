@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Khong tim thay Node.js. Hay cai Node.js 20 tro len, roi mo lai cua so nay.
  pause
  exit /b 1
)
if not exist .env (
  echo Chua co file .env. Dang tao tu .env.example...
  copy .env.example .env >nul
  echo Hay mo file .env, dien GROQ_API_KEYS va DISCORD_WEBHOOK_URL, sau do chay lai start.bat.
  notepad .env
  pause
  exit /b 0
)
echo Dang khoi dong PsychoClass...
npm start
pause

@echo off
echo ===================================================
echo 🚀 Starting ID Card Data Collector Server...
echo ===================================================
echo.
echo 📌 Admin Dashboard: http://localhost:3000/admin.html
echo 📌 Student Form:    http://localhost:3000/
echo 📁 Local Photos:    E:\Coding\ID Card Generation\uploads\photos
echo.
echo Launching public internet shareable link in 3 seconds...
timeout /t 3
start cmd /k "npx localtunnel --port 3000"
node server.js
pause

@echo off
start "ngrok" cmd /k "ngrok http 12080"
timeout /t 3 /nobreak
pm2 start index.js --name sas-bot
@echo off
cd /d "%~dp0..\web"
set VITE_APP_URL=http://localhost:5173
set VITE_API_URL=http://localhost:8080
set VITE_TURNSTILE_KEY=1x00000000000000000000AA
set VITE_TURNSTILE_BYPASS_TOKEN=warmbly-local-turnstile-bypass
call pnpm dev >> ..\.run\web.log 2>&1

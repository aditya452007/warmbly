@echo off
rem Direct node + tsx invocation: npx loses cwd under Start-Process (Access
rem denied on the npm cache exec dir), and `node --env-file` is the reliable
rem way to load bridge/.env here.
cd /d "%~dp0..\bridge"
rem Scoped to the dev workspace org (22222222-…0001); overrides .env's seed key,
rem which belongs to the Acme seed org and 404s on the user's campaigns.
set WARMBLY_API_KEY=wmbly_local_bridge_full_access_0000000000
node --env-file=.env node_modules\tsx\dist\cli.mjs src/index.ts >> ..\.run\bridge.log 2>&1

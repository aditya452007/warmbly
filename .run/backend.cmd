@echo off
cd /d "%~dp0.."
set APP_ENV=dev
set AWS_CONFIG_ENABLED=false
set EVENTBUS_PROVIDER=nats
set NATS_URL=nats://localhost:4222
set CODEC_PROVIDER=json
set KMS_PROVIDER=local
set KMS_LOCAL_MASTER_KEY=Xr0JA7gqF2POy29a7MRByyqddivTNt8WOyKsOXklazk=
set CREDENTIALS_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
set BLOB_PROVIDER=filesystem
set BLOB_FS_ROOT=/tmp/warmbly-blobs
set BLOB_PUBLIC_BASE_URL=http://localhost:8080/public
set TASKS_PROVIDER=local
set BILLING_PROVIDER=none
set CAPTCHA_PROVIDER=none
set PUBSUB_ENABLED=false
set ENCRYPTED_KEYS_PROVIDER=postgres
set PRIMARY_DB=postgres://warmbly:warmbly@127.0.0.1:15433/warmbly_dev?sslmode=disable
set REDIS=redis://localhost:16379
set APP_URL=http://localhost:5173
set WEBSOCKET_URL=ws://localhost:4000/socket/websocket
set AUTH_SECRET=local-dev-auth-secret-minimum-32-characters-long
set EMAIL_NAME=Warmbly Dev
set EMAIL_ADDRESS=dev@warmbly.local
set TRACKING_DOMAIN=localhost:3000
set GEODB_PATH=data/GeoLite2-City.mmdb
set MAIL_TRANSPORT=smtp
set SMTP_HOST=localhost
set SMTP_PORT=11025
set SMTP_SECURITY=none
set AUTH_LOGIN_CODE=off
set INTERNAL_API_TOKEN=local-dev-internal-token
.run\backend.exe >> .run\backend.log 2>&1

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
set MAIL_TLS_INSECURE=true
set REDIS=redis://localhost:16379
set WORKER_ID=10c8f5e4-1c39-5b2a-9c8b-3d2f0a8b1a01
set ENCRYPTED_KEYS_PROVIDER=http
set ENCRYPTED_KEYS_BACKEND_URL=http://localhost:8080
set ENCRYPTED_KEYS_WORKER_TOKEN=local-dev-internal-token
.run\worker.exe >> .run\worker.log 2>&1
